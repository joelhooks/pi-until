import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { systemClock } from "../src/clock.ts";
import { initialFacts, dueAt, phaseOffsetMs } from "../src/domain.ts";
import type { WatchDefinition } from "../src/domain.ts";
import {
  claimHandoff,
  handoffOptionsFromEnv,
  publishHandoff,
} from "../src/handoff.ts";
import { newestSuspension, suspensionData } from "../src/suspension.ts";
import { FakeSession, loadExtension as loadPi, receiptOf } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

// Positive transfer fixtures declare the exact target; untargeted cases live
// in handoff-binding.test.ts and use the unwrapped fake factory.
const loadExtension = (
  session: FakeSession,
  options: Parameters<typeof loadPi>[1] = {}
) => {
  const handoff = options.handoff;
  return loadPi(session, {
    ...options,
    handoff:
      handoff === undefined || handoff === false
        ? handoff
        : {
            ...handoff,
            ...(handoff.predecessorId === undefined
              ? {}
              : { successorId: session.id }),
          },
  });
};

const directories: string[] = [];
const live: FakeExtension[] = [];
afterEach(async () => {
  await Promise.all(
    live.splice(0).map((extension) => extension.shutdown("new"))
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const mailbox = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-until-handoff-"));
  directories.push(directory);
  return directory;
};

const mailboxData = () => {
  const definition: WatchDefinition = {
    kind: "until",
    intervalMs: 60_000,
    label: "inert",
    gate: { command: "false", cwd: tmpdir(), checkTimeoutMs: 1000 },
    wake: "agent",
  };
  return suspensionData(
    [{ definition, facts: initialFacts(definition, "inert", Date.now()) }],
    Date.now(),
    "quit",
    "parent"
  );
};

const arm = async (
  extension: FakeExtension,
  session: FakeSession,
  action: "start" | "repeat"
) =>
  receiptOf(
    await extension.tool(
      "arm",
      {
        action,
        condition: "false",
        intervalSeconds: 60,
        timeoutSeconds: 3600,
        ...(action === "repeat"
          ? {
              instruction: "Inspect only fresh records",
              quickRef: "cursor:42",
              contextRefs: [{ label: "cursor", target: "opaque:42" }],
            }
          : {}),
      },
      new AbortController().signal,
      undefined,
      session.context().ctx
    )
  );

const ids = async (extension: FakeExtension, session: FakeSession) => {
  const result = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    session.context().ctx
  );
  return result.details && "watches" in result.details
    ? result.details.watches.map((receipt) => receipt.id)
    : [];
};

describe("successor extension", () => {
  it("keeps the wait visible in list without blocking the session", async () => {
    const directory = await mailbox();
    const session = new FakeSession();
    const extension = loadExtension(session, {
      handoff: { directory, predecessorId: "absent", waitMs: 300_000 },
    });
    live.push(extension);
    await extension.sessionStart("startup", session.context().ctx);
    const result = await extension.tool(
      "list",
      { action: "list" },
      new AbortController().signal,
      undefined,
      session.context().ctx
    );
    expect(result.content[0]?.text).toContain("handoff: waiting for absent");
    expect(result.content[0]?.text).toContain("until ");
  });

  it("reports a consume fault but still restores the original same-session quit", async () => {
    const directory = await mailbox();
    const session = new FakeSession();
    const first = loadExtension(session, { handoff: { directory } });
    live.push(first);
    const watch = await arm(first, session, "start");
    await first.shutdown("quit");
    await rm(join(directory, `${session.id}.json`));
    await mkdir(join(directory, "claimed"), { recursive: true });
    await writeFile(
      join(directory, "claimed", `${session.id}.broken.json`),
      "broken JSON"
    );
    const second = loadExtension(session, { handoff: { directory } });
    live.push(second);
    const { ctx, notify } = session.context();
    await expect(second.sessionStart("startup", ctx)).resolves.toBeUndefined();
    expect(await ids(second, session)).toEqual([watch.id]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("skipped unreadable mailbox file"),
      "warning"
    );
  });

  it("does not start watches after shutdown races asynchronous startup", async () => {
    const directory = await mailbox();
    const session = new FakeSession();
    const first = loadExtension(session, { handoff: { directory } });
    live.push(first);
    await arm(first, session, "start");
    await first.shutdown("quit");
    const second = loadExtension(session, { handoff: { directory } });
    live.push(second);
    const starting = second.sessionStart("startup", session.context().ctx);
    await second.shutdown("new");
    await starting;
    expect(await ids(second, session)).toEqual([]);
    expect(second.messages).toEqual([]);
  });

  it("does not replay terminal requests on same-process reload", async () => {
    const directory = await mailbox();
    const session = new FakeSession();
    const first = loadExtension(session, { handoff: { directory } });
    live.push(first);
    const busy = session.context({ idle: false }).ctx;
    await first.tool(
      "arm",
      { action: "start", condition: "true" },
      new AbortController().signal,
      undefined,
      busy
    );
    await vi.waitFor(() =>
      expect(
        session.entries.some(
          (entry) =>
            entry.type === "custom" && entry.customType === "pi-until-finished"
        )
      ).toBe(true)
    );
    await first.shutdown("reload", busy);
    const second = loadExtension(session, { handoff: { directory } });
    live.push(second);
    await second.sessionStart("reload", session.context().ctx);
    expect(second.messages).toEqual([]);
  });

  it("reports missing adoption readback and retains the claim payload", async () => {
    const directory = await mailbox();
    const parent = new FakeSession();
    const first = loadExtension(parent, { handoff: { directory } });
    live.push(first);
    await arm(first, parent, "start");
    await first.shutdown("quit");
    const child = new FakeSession();
    const second = loadExtension(child, {
      handoff: { directory, predecessorId: parent.id },
    });
    live.push(second);
    second.appendEntry.mockImplementation(() => {});
    const { ctx, notify } = child.context();
    await second.sessionStart("startup", ctx);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("could not read back"),
        "error"
      )
    );
    expect(await readdir(join(directory, "claimed"))).toContain(
      `${parent.id}!${child.id}.json`
    );
    expect(await ids(second, child)).toEqual([]);
  });
  it("does not replace a published quit with an empty snapshot on repeated shutdown", async () => {
    const directory = await mailbox();
    const parent = new FakeSession();
    const first = loadExtension(parent, { handoff: { directory } });
    live.push(first);
    const watch = await arm(first, parent, "start");
    await first.shutdown("quit");
    await first.shutdown("quit");
    const result = await claimHandoff({
      directory,
      predecessorId: parent.id,
      successorId: "child",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      kind: "claimed",
      handoff: { suspension: { watches: [{ facts: { id: watch.id } }] } },
    });
  });
  it.each(["before-journal", "between-journal-writes"])(
    "recovers a claim without duplicating work: %s",
    async (crash) => {
      const directory = await mailbox();
      const parent = new FakeSession();
      const child = new FakeSession();
      const first = loadExtension(parent, { handoff: { directory } });
      live.push(first);
      const original = await arm(first, parent, "repeat");
      await first.shutdown("quit");
      const claimed = await claimHandoff({
        directory,
        predecessorId: parent.id,
        successorId: child.id,
        signal: new AbortController().signal,
        waitMs: 20,
      });
      expect(claimed.kind).toBe("claimed");
      if (claimed.kind !== "claimed") throw new Error("claim missing");
      if (crash === "between-journal-writes")
        child.appendCustom("pi-until-suspended", {
          ...claimed.handoff.suspension,
          sessionId: child.id,
          handoff: {
            predecessorId: parent.id,
            transferId: claimed.handoff.transferId,
          },
        });
      const second = loadExtension(child, {
        handoff: { directory, predecessorId: parent.id },
      });
      live.push(second);
      await second.sessionStart("startup", child.context().ctx);
      await vi.waitFor(async () =>
        expect(await ids(second, child)).toEqual([original.id])
      );
      expect(
        child.entries.filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "pi-until-suspended"
        )
      ).toHaveLength(1);
      await second.shutdown("quit");
      expect(await readdir(join(directory, "claimed"))).not.toContain(
        `${parent.id}!${child.id}.json`
      );
      expect(
        child.entries.filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-until-resumed" &&
            typeof entry.data === "object" &&
            entry.data !== null &&
            "predecessorId" in entry.data &&
            entry.data.predecessorId === parent.id
        )
      ).toHaveLength(1);
      const thirdSession = new FakeSession();
      const third = loadExtension(thirdSession, {
        handoff: { directory, predecessorId: child.id },
      });
      live.push(third);
      await third.sessionStart("startup", thirdSession.context().ctx);
      await vi.waitFor(async () =>
        expect(await ids(third, thirdSession)).toEqual([original.id])
      );
    }
  );

  it("prefers the pi-until declaration and never infers succession from a parent", () => {
    expect(
      handoffOptionsFromEnv({
        PI_UNTIL_SUCCEEDS: "until",
        RATKING_SUCCEEDS: "rat",
      }).predecessorId
    ).toBe("until");
    expect(
      handoffOptionsFromEnv({ RATKING_SUCCEEDS: "rat" }).predecessorId
    ).toBe("rat");
    expect(
      handoffOptionsFromEnv({ parentSession: "parent" }).predecessorId
    ).toBeUndefined();
  });

  it.each(["fork", "new", "undeclared"] as const)(
    "does not adopt for %s",
    async (reason) => {
      const directory = await mailbox();
      const parent = new FakeSession();
      const first = loadExtension(parent, { handoff: { directory } });
      live.push(first);
      await arm(first, parent, "start");
      await first.shutdown("quit");
      const child = parent.fork();
      const second = loadExtension(child, {
        handoff: {
          directory,
          ...(reason === "undeclared" ? {} : { predecessorId: parent.id }),
        },
      });
      live.push(second);
      await second.sessionStart(
        reason === "undeclared" ? "startup" : reason,
        child.context().ctx
      );
      expect(await ids(second, child)).toEqual([]);
      expect(
        child.entries.filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "pi-until-resumed"
        )
      ).toHaveLength(0);
    }
  );

  it("reports nothing to adopt after a bounded wait for a crashed predecessor", async () => {
    const directory = await mailbox();
    const child = new FakeSession();
    const second = loadExtension(child, {
      handoff: { directory, predecessorId: "crashed", waitMs: 20 },
    });
    live.push(second);
    const { ctx, notify } = child.context();
    await second.sessionStart("startup", ctx);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("nothing to adopt"),
        "warning"
      )
    );
    expect(await ids(second, child)).toEqual([]);
  });

  it("keeps completed and cancelled watches gone and reports expiry while unowned", async () => {
    const directory = await mailbox();
    const parent = new FakeSession();
    const first = loadExtension(parent, { handoff: { directory } });
    live.push(first);
    const cancelled = await arm(first, parent, "start");
    const completed = await arm(first, parent, "repeat");
    await first.tool(
      "cancel",
      { action: "cancel", id: cancelled.id },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    );
    await first.tool(
      "complete",
      { action: "complete", id: completed.id },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    );
    const pending = await arm(first, parent, "start");
    await first.shutdown("quit");
    const child = new FakeSession();
    const second = loadExtension(child, {
      clock: { ...systemClock, now: () => Date.now() + 7_200_000 },
      handoff: { directory, predecessorId: parent.id },
    });
    live.push(second);
    const { ctx, notify } = child.context();
    await second.sessionStart("startup", ctx);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith("Skipped 1 expired watch", "warning")
    );
    expect(await ids(second, child)).toEqual([]);
    expect(
      newestSuspension(child.entries)?.watches.map((watch) => watch.facts.id)
    ).toEqual([pending.id]);
    expect(child.entries.at(-1)).toMatchObject({
      data: { resumed: 0, skippedExpired: 1 },
    });
  });

  it.each(["queued", "unacknowledged", "started", "consumed"])(
    "preserves terminal wake ownership: %s",
    async (state) => {
      const directory = await mailbox();
      const parent = new FakeSession();
      const first = loadExtension(parent, {
        acknowledgeMessages: state !== "unacknowledged",
        handoff: { directory },
      });
      live.push(first);
      const busy = parent.context({
        idle: state === "started" || state === "unacknowledged",
      }).ctx;
      const receipt = receiptOf(
        await first.tool(
          "arm",
          { action: "start", condition: "true", intervalSeconds: 60 },
          new AbortController().signal,
          undefined,
          busy
        )
      );
      await vi.waitFor(() =>
        expect(
          parent.entries.some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "pi-until-finished"
          )
        ).toBe(true)
      );
      if (state === "started" || state === "unacknowledged")
        await vi.waitFor(() => expect(first.messages).toHaveLength(1));
      if (state === "consumed") {
        await first.tool(
          "status",
          { action: "status", id: receipt.id },
          new AbortController().signal,
          undefined,
          busy
        );
        expect(parent.entries).toContainEqual(
          expect.objectContaining({
            customType: "pi-until-wake-handled",
            data: expect.objectContaining({ disposition: "consumed" }),
          })
        );
      }
      await first.shutdown("quit", busy);
      const secondSession = new FakeSession();
      const second = loadExtension(secondSession, {
        handoff: { directory, predecessorId: parent.id, waitMs: 30 },
      });
      live.push(second);
      const { ctx, notify } = secondSession.context();
      await second.sessionStart("startup", ctx);
      const count = state === "queued" || state === "unacknowledged" ? 1 : 0;
      if (count > 0)
        await vi.waitFor(() =>
          expect(
            secondSession.entries.some(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "pi-until-resumed"
            )
          ).toBe(true)
        );
      if (count === 0)
        await vi.waitFor(() =>
          expect(notify).toHaveBeenCalledWith(
            expect.stringContaining("predecessor had nothing to hand off"),
            "info"
          )
        );
      expect(second.messages).toHaveLength(count);
      expect(
        newestSuspension(parent.entries)?.terminalFollowUps ?? []
      ).toHaveLength(count);
      await second.sessionStart("startup", secondSession.context().ctx);
      expect(second.messages).toHaveLength(count);
    }
  );

  it("lets only one racing successor adopt, including against same-session recovery", async () => {
    const directory = await mailbox();
    const parent = new FakeSession();
    const first = loadExtension(parent, { handoff: { directory } });
    live.push(first);
    await arm(first, parent, "start");
    await first.shutdown("quit");
    const children = [new FakeSession(), new FakeSession()];
    const successors = children.map((child) => ({
      child,
      extension: loadExtension(child, {
        handoff: { directory, predecessorId: parent.id, waitMs: 30 },
      }),
    }));
    live.push(...successors.map(({ extension }) => extension));
    await Promise.all(
      successors.map(({ extension, child }) =>
        extension.sessionStart("startup", child.context().ctx)
      )
    );
    await vi.waitFor(() =>
      expect(
        children
          .flatMap((session) => session.entries)
          .filter(
            (entry) =>
              entry.type === "custom" && entry.customType === "pi-until-resumed"
          )
      ).toHaveLength(1)
    );
    const adopted = await Promise.all(
      successors.map(({ extension, child }) => ids(extension, child))
    );
    expect(adopted.flat()).toHaveLength(1);
    await vi.waitFor(async () =>
      expect(await readdir(join(directory, "claimed"))).toHaveLength(0)
    );
    expect(await readdir(join(directory, "receipts"))).toHaveLength(1);
    const restarted = loadExtension(parent, { handoff: { directory } });
    live.push(restarted);
    await restarted.sessionStart("startup", parent.context().ctx);
    expect(await ids(restarted, parent)).toHaveLength(0);
  });
  it("does not resurrect a watch after its original session resumed and cancelled it", async () => {
    const directory = await mailbox();
    const parent = new FakeSession();
    const first = loadExtension(parent, { handoff: { directory } });
    live.push(first);
    const watch = await arm(first, parent, "start");
    await first.shutdown("quit");
    const restarted = loadExtension(parent, { handoff: { directory } });
    live.push(restarted);
    await restarted.sessionStart("startup", parent.context().ctx);
    await restarted.tool(
      "cancel",
      { action: "cancel", id: watch.id },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    );
    const child = new FakeSession();
    const successor = loadExtension(child, {
      handoff: { directory, predecessorId: parent.id, waitMs: 30 },
    });
    live.push(successor);
    const { ctx, notify } = child.context();
    await successor.sessionStart("startup", ctx);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("nothing to adopt"),
        "warning"
      )
    );
    expect(await ids(successor, child)).toHaveLength(0);
  });
  it.each(["successor-first", "predecessor-first"])(
    "adopts watch and repeat exactly once: %s",
    async (order) => {
      const directory = await mailbox();
      const parent = new FakeSession();
      const child = new FakeSession();
      const first = loadExtension(parent, { handoff: { directory } });
      const second = loadExtension(child, {
        handoff: { directory, predecessorId: parent.id, waitMs: 5000 },
      });
      live.push(first, second);
      const watches = [
        await arm(first, parent, "start"),
        await arm(first, parent, "repeat"),
      ];
      // Finish the initial one-shot check before suspension. Otherwise a
      // resumed in-flight false check legitimately computes its next interval.
      await Promise.all(
        watches
          .filter((receipt) => receipt.kind === "until")
          .map(async (watch) =>
            vi.waitFor(async () => {
              const status = receiptOf(
                await first.tool(
                  "status",
                  { action: "status", id: watch.id },
                  new AbortController().signal,
                  undefined,
                  parent.context().ctx
                )
              );
              expect(status.lastExitCode).toBe(1);
            })
          )
      );
      if (order === "successor-first")
        await second.sessionStart("startup", child.context().ctx);
      await first.shutdown("quit");
      if (order === "predecessor-first")
        await second.sessionStart("startup", child.context().ctx);
      await vi.waitFor(async () =>
        expect(await ids(second, child)).toEqual(
          expect.arrayContaining(watches.map((receipt) => receipt.id))
        )
      );
      expect(await ids(second, child)).toHaveLength(2);
      expect(
        child.entries.filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "pi-until-resumed"
        )
      ).toHaveLength(1);
      const original = newestSuspension(parent.entries);
      const imported = newestSuspension(child.entries);
      expect(imported?.watches).toEqual(original?.watches);
      if (original === undefined || imported === undefined)
        throw new Error("missing transfer snapshots");
      await Promise.all(
        original.watches.map(async (watch) => {
          const current = receiptOf(
            await second.tool(
              "status",
              { action: "status", id: watch.facts.id },
              new AbortController().signal,
              undefined,
              child.context().ctx
            )
          );
          expect(current.nextDueAt).toBe(
            new Date(dueAt(watch.definition, watch.facts)).toISOString()
          );
          expect(current.expiresAt).toBe(
            new Date(watch.definition.expiresAt ?? 0).toISOString()
          );
          const restored = imported.watches.find(
            (candidate) => candidate.facts.id === watch.facts.id
          );
          if (restored === undefined) throw new Error("missing restored watch");
          expect(phaseOffsetMs(restored.definition, restored.facts.id)).toBe(
            phaseOffsetMs(watch.definition, watch.facts.id)
          );
          if (watch.definition.kind === "recurring") {
            expect(current.contextRefs).toEqual(
              watch.definition.snapshot.contextRefs
            );
            expect(current.quickRef).toBe(watch.definition.snapshot.quickRef);
          }
        })
      );
      await second.sessionStart("startup", child.context().ctx);
      expect(await ids(second, child)).toHaveLength(2);
    }
  );
});

describe("successor mailbox", () => {
  it("rejects path traversal and does not claim after cancellation", async () => {
    const directory = await mailbox();
    await expect(
      claimHandoff({
        directory,
        predecessorId: "../parent",
        successorId: "child",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("safe session ids");
    await publishHandoff(directory, mailboxData());
    const controller = new AbortController();
    controller.abort();
    await expect(
      claimHandoff({
        directory,
        predecessorId: "parent",
        successorId: "child",
        signal: controller.signal,
      })
    ).resolves.toEqual({ kind: "aborted" });
    await expect(
      claimHandoff({
        directory,
        predecessorId: "parent",
        successorId: "child",
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ kind: "claimed" });
  });
  it("claims a graceful quit exactly once when two successors race", async () => {
    const directory = await mailbox();
    await publishHandoff(directory, mailboxData());
    const results = await Promise.all(
      ["child-a", "child-b"].map((successorId) =>
        claimHandoff({
          directory,
          predecessorId: "parent",
          successorId,
          signal: new AbortController().signal,
          waitMs: 20,
        })
      )
    );
    expect(results.filter((result) => result.kind === "claimed")).toHaveLength(
      1
    );
    expect(results.filter((result) => result.kind === "empty")).toHaveLength(1);
  });
});
