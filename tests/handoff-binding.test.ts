import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { SimulatedClock } from "xstate";

import { systemClock } from "../src/clock.ts";
import { initialFacts } from "../src/domain.ts";
import type { WatchDefinition } from "../src/domain.ts";
import { publishHandoff } from "../src/handoff.ts";
import { newestSuspension, suspensionData } from "../src/suspension.ts";
import type { TelemetrySink } from "../src/telemetry.ts";
import { FakeSession, loadExtension, receiptOf } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const pointer = (predecessorId: string) => ({
  predecessorId,
  notBefore: new Date(0).toISOString(),
});
const roots: string[] = [];
const extensions: FakeExtension[] = [];
afterEach(async () => {
  await Promise.all(
    extensions.splice(0).map((extension) => extension.shutdown("new"))
  );
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const setup = async (bound = true) => {
  const directory = await mkdtemp(join(tmpdir(), "until-binding-"));
  roots.push(directory);
  const session = new FakeSession();
  const definition: WatchDefinition = {
    kind: "until",
    label: "inert",
    intervalMs: 60_000,
    gate: { command: "false", cwd: tmpdir(), checkTimeoutMs: 1000 },
    wake: "agent",
  };
  const data = suspensionData(
    [{ definition, facts: initialFacts(definition, "watch", Date.now()) }],
    Date.now(),
    "quit",
    "parent"
  );
  const handoff = {
    directory,
    predecessorId: "parent",
    waitMs: 200,
    ...(bound ? { successorId: session.id } : {}),
  };
  const extension = loadExtension(session, { handoff });
  extensions.push(extension);
  return { directory, session, data, handoff, extension };
};
const listed = async (extension: FakeExtension, session: FakeSession) => {
  const result = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    session.context().ctx
  );
  return result.details && "watches" in result.details
    ? result.details.watches.map((watch) => watch.id)
    : [];
};

it.each([false, true])(
  "adopts only with the exact target (primary: %s)",
  async (primary) => {
    const { directory, session, data, handoff } = await setup(false);
    const environment = { PI_UNTIL_SCOPE: "parent-process" };
    const extension = loadExtension(session, {
      environment,
      handoff: { ...handoff, ...(primary ? { successorId: session.id } : {}) },
    });
    extensions.push(extension);
    await publishHandoff(directory, data);
    await extension.sessionStart("startup", session.context().ctx);
    expect(environment.PI_UNTIL_SCOPE).toBe("parent-process");
    if (primary)
      await vi.waitFor(async () =>
        expect(await listed(extension, session)).toEqual(["watch"])
      );
    else {
      const result = await extension.tool(
        "list",
        { action: "list" },
        new AbortController().signal,
        undefined,
        session.context().ctx
      );
      expect(result.content[0]?.text).not.toContain("handoff: waiting");
      expect(await listed(extension, session)).toEqual([]);
      await expect(stat(join(directory, "parent.json"))).resolves.toBeDefined();
    }
  }
);
it("does not adopt an untargeted top-level declaration", async () => {
  const { directory, session, data, handoff } = await setup(false);
  const environment: NodeJS.ProcessEnv = {};
  const extension = loadExtension(session, { environment, handoff });
  extensions.push(extension);
  await publishHandoff(directory, data);
  await extension.sessionStart("startup", session.context().ctx);
  expect(environment).not.toHaveProperty("PI_UNTIL_SCOPE");
  expect(await listed(extension, session)).toEqual([]);
  await expect(stat(join(directory, "parent.json"))).resolves.toBeDefined();
});
it("does not stamp any env marker when there is no declaration", async () => {
  const session = new FakeSession();
  const environment: NodeJS.ProcessEnv = {};
  const extension = loadExtension(session, { environment });
  extensions.push(extension);
  await extension.sessionStart("startup", session.context().ctx);
  expect(environment).not.toHaveProperty("PI_UNTIL_SCOPE");
});
it.each([false, true])(
  "warns when the target matches but no predecessor is named (remembered: %s)",
  async (remembered) => {
    const { directory, session, extension: original } = await setup();
    if (remembered) {
      await original.sessionStart("startup", session.context().ctx);
      await original.shutdown("new");
    }
    const extension = loadExtension(session, {
      handoff: { directory, successorId: session.id },
    });
    extensions.push(extension);
    const { ctx, notify } = session.context();
    await extension.sessionStart("startup", ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("no predecessor"),
      "warning"
    );
    expect(await listed(extension, session)).toEqual([]);
  }
);
it("journals a refused reopen so expired ownership receipts cannot resurrect it", async () => {
  const { directory, session: parent } = await setup();
  const first = loadExtension(parent, { handoff: { directory } });
  extensions.push(first);
  const watch = receiptOf(
    await first.tool(
      "arm",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  await first.shutdown("quit");
  const child = parent.fork();
  const successor = loadExtension(child, {
    handoff: { directory, predecessorId: parent.id, successorId: child.id },
  });
  extensions.push(successor);
  await successor.sessionStart("startup", child.context().ctx);
  await vi.waitFor(async () =>
    expect(await listed(successor, child)).toEqual([watch.id])
  );
  await vi.waitFor(async () =>
    expect(
      await stat(join(directory, "receipts", `${parent.id}!${child.id}.json`))
    ).toBeDefined()
  );
  const reopened = loadExtension(parent, { handoff: { directory } });
  extensions.push(reopened);
  await reopened.sessionStart("startup", parent.context().ctx);
  expect(await listed(reopened, parent)).toEqual([]);
  const marker = parent.entries.find(
    (entry) =>
      entry.type === "custom" && entry.customType === "pi-until-resumed"
  );
  expect(marker).toMatchObject({
    data: {
      disposition: "transferred",
      transferId: expect.any(String),
      resumed: 0,
    },
  });
  await rm(join(directory, "receipts"), { recursive: true });
  const later = loadExtension(parent, { handoff: { directory } });
  extensions.push(later);
  await later.sessionStart("startup", parent.context().ctx);
  expect(await listed(later, parent)).toEqual([]);
  const fresh = receiptOf(
    await later.tool(
      "fresh",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  await later.shutdown("quit");
  const next = parent.fork();
  const nextOwner = loadExtension(next, {
    handoff: { directory, predecessorId: parent.id, successorId: next.id },
  });
  extensions.push(nextOwner);
  await nextOwner.sessionStart("startup", next.context().ctx);
  await vi.waitFor(async () =>
    expect(await listed(nextOwner, next)).toEqual([fresh.id])
  );
});
it("reports the running and missing ids after a partial adoption", async () => {
  const { directory, session, handoff, data } = await setup();
  const definition = data.watches[0]?.definition;
  if (!definition) throw new Error("missing definition");
  const watches = ["partial-a", "partial-b", "partial-c"].map((id) => ({
    definition,
    facts: initialFacts(definition, id, Date.now()),
  }));
  await publishHandoff(directory, { ...data, watches });
  const telemetry: TelemetrySink = {
    enabled: true,
    filePath: "memory",
    record: (_session, event) => {
      if (event.event === "started" && event.resumed)
        throw new Error("injected telemetry boundary failure");
      return Promise.resolve();
    },
  };
  const extension = loadExtension(session, { handoff, telemetry });
  extensions.push(extension);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Running watch ids: partial-a"),
      "error"
    )
  );
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("Needs re-arming: partial-b, partial-c"),
    "error"
  );
  expect(await listed(extension, session)).toEqual(["partial-a"]);
});
it("clears its empty quit and rejects a stale tombstone at the fork point", async () => {
  const { directory, session: parent } = await setup();
  const first = loadExtension(parent, { handoff: { directory } });
  extensions.push(first);
  await first.shutdown("quit");
  const stale = JSON.parse(
    await readFile(join(directory, `${parent.id}.json`), "utf-8")
  );
  const restored = loadExtension(parent, { handoff: { directory } });
  extensions.push(restored);
  await restored.sessionStart("startup", parent.context().ctx);
  expect(
    parent.entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-until-mailbox-cleared"
    )
  ).toBe(true);
  await expect(
    stat(join(directory, `${parent.id}.json`))
  ).rejects.toMatchObject({ code: "ENOENT" });
  const watch = receiptOf(
    await restored.tool(
      "arm",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  const child = parent.fork();
  const successor = loadExtension(child, {
    handoff: { directory, predecessorId: parent.id, successorId: child.id },
  });
  extensions.push(successor);
  // Reintroduce an obsolete file to exercise the independent freshness guard.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(directory, `${parent.id}.json`),
    JSON.stringify({ ...stale, suspendedAt: new Date(0).toISOString() })
  );
  await successor.sessionStart("startup", child.context().ctx);
  const view = await successor.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    child.context().ctx
  );
  expect(view.content[0]?.text).toContain("handoff: waiting");
  await restored.shutdown("quit");
  await vi.waitFor(async () =>
    expect(await listed(successor, child)).toEqual([watch.id])
  );
});
it("forwards a waiting predecessor through a chained restart", async () => {
  const { directory, session: a } = await setup();
  const first = loadExtension(a, { handoff: { directory } });
  extensions.push(first);
  const watch = receiptOf(
    await first.tool(
      "arm",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      a.context().ctx
    )
  );
  const b = a.fork();
  const second = loadExtension(b, {
    handoff: { directory, predecessorId: a.id, successorId: b.id },
  });
  extensions.push(second);
  await second.sessionStart("startup", b.context().ctx);
  const c = b.fork();
  const third = loadExtension(c, {
    handoff: { directory, predecessorId: b.id, successorId: c.id },
  });
  extensions.push(third);
  await third.sessionStart("startup", c.context().ctx);
  await second.shutdown("quit");
  await vi.waitFor(() =>
    expect(newestSuspension(c.entries)?.pendingPredecessor).toMatchObject({
      predecessorId: a.id,
    })
  );
  await first.shutdown("quit");
  await vi.waitFor(async () =>
    expect(await listed(third, c)).toEqual([watch.id])
  );
  const reopened = loadExtension(b, { handoff: { directory } });
  extensions.push(reopened);
  await reopened.sessionStart("startup", b.context().ctx);
  const view = await reopened.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    b.context().ctx
  );
  expect(view.content[0]?.text).not.toContain("handoff:");
  expect(await listed(reopened, b)).toEqual([]);
});
it("carries an interrupted claim into the quitting successor's own handoff", async () => {
  const { directory, session: a } = await setup();
  const first = loadExtension(a, { handoff: { directory } });
  extensions.push(first);
  const watch = receiptOf(
    await first.tool(
      "arm",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      a.context().ctx
    )
  );
  const b = a.fork();
  const second = loadExtension(b, {
    handoff: { directory, predecessorId: a.id, successorId: b.id },
  });
  extensions.push(second);
  const append = second.appendEntry.getMockImplementation();
  if (!append) throw new Error("missing fake boundary");
  second.appendEntry.mockImplementation((type, data) => {
    if (type === "pi-until-suspended") throw new Error("injected interruption");
    append(type, data);
  });
  const { ctx, notify } = b.context();
  await second.sessionStart("startup", ctx);
  await first.shutdown("quit");
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("handoff failed"),
      "error"
    )
  );
  second.appendEntry.mockImplementation(append);
  const c = b.fork();
  const third = loadExtension(c, {
    handoff: { directory, predecessorId: b.id, successorId: c.id },
  });
  extensions.push(third);
  await third.sessionStart("startup", c.context().ctx);
  await second.shutdown("quit");
  await vi.waitFor(async () =>
    expect(await listed(third, c)).toEqual([watch.id])
  );
  await expect(
    stat(join(directory, "claimed", `${a.id}!${b.id}.json`))
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("limits transitive claims to three predecessor payloads", async () => {
  const { directory, session, extension, data } = await setup();
  await Promise.all([
    publishHandoff(directory, data, pointer("second")),
    publishHandoff(
      directory,
      { ...data, sessionId: "second" },
      pointer("third")
    ),
    publishHandoff(
      directory,
      { ...data, sessionId: "third" },
      pointer("fourth")
    ),
    publishHandoff(directory, { ...data, sessionId: "fourth" }),
  ]);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("chain limit"),
      "warning"
    )
  );
  await expect(stat(join(directory, "fourth.json"))).resolves.toBeDefined();
});
it("shows old claimed payloads without deleting them", async () => {
  const { directory, session } = await setup();
  const { mkdir, writeFile, utimes } = await import("node:fs/promises");
  await mkdir(join(directory, "claimed"));
  const file = join(directory, "claimed", "failed.json");
  await writeFile(file, "inspection fixture");
  await utimes(file, new Date(0), new Date(0));
  const extension = loadExtension(session, { handoff: { directory } });
  extensions.push(extension);
  await extension.sessionStart("startup", session.context().ctx);
  await vi.waitFor(async () => {
    const view = await extension.tool(
      "list",
      { action: "list" },
      new AbortController().signal,
      undefined,
      session.context().ctx
    );
    expect(view.content[0]?.text).toContain("claimed: 1 older than 7 days");
  });
  expect(await readFile(file, "utf-8")).toBe("inspection fixture");
});
it("keeps a passive late watcher after the visible wait", async () => {
  const { directory, session, data, handoff } = await setup();
  const extension = loadExtension(session, {
    handoff: { ...handoff, waitMs: 10 },
  });
  extensions.push(extension);
  const { ctx, notify, setStatus } = session.context();
  await extension.sessionStart("startup", ctx);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("nothing to adopt"),
      "warning"
    )
  );
  expect(setStatus).toHaveBeenCalledWith(
    "pi-until-handoff",
    expect.stringContaining("watching for a late handoff")
  );
  await publishHandoff(directory, data);
  await vi.waitFor(async () =>
    expect(await listed(extension, session)).toEqual(["watch"])
  );
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("late handoff"),
    "info"
  );
});
it("refuses a primary binding for a different startup session", async () => {
  const { directory, session, data, handoff } = await setup();
  const extension = loadExtension(session, {
    handoff: { ...handoff, successorId: "different" },
  });
  extensions.push(extension);
  await publishHandoff(directory, data);
  await extension.sessionStart("startup", session.context().ctx);
  expect(await listed(extension, session)).toEqual([]);
  await expect(stat(join(directory, "parent.json"))).resolves.toBeDefined();
});
it("refuses untargeted startup even with its own Pi session id", async () => {
  const { directory, session, data, handoff } = await setup(false);
  const extension = loadExtension(session, {
    handoff,
    environment: { PI_SESSION_ID: session.id },
  });
  extensions.push(extension);
  await publishHandoff(directory, data);
  await extension.sessionStart("startup", session.context().ctx);
  expect(await listed(extension, session)).toEqual([]);
});
it("finishes an empty handoff without restarting the wait after reload", async () => {
  const { directory, session, extension, handoff } = await setup();
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  await publishHandoff(
    directory,
    suspensionData([], Date.now(), "quit", "parent")
  );
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("predecessor had nothing"),
      "info"
    )
  );
  await extension.shutdown("reload");
  const reloaded = loadExtension(session, { handoff });
  extensions.push(reloaded);
  await reloaded.sessionStart("reload", session.context().ctx);
  const result = await reloaded.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    session.context().ctx
  );
  expect(result.content[0]?.text).not.toContain("handoff: waiting");
});
it("resets shutdown after /new and writes the new session's quit", async () => {
  const { directory, extension } = await setup();
  await extension.shutdown("new");
  const next = new FakeSession();
  await extension.sessionStart("new", next.context().ctx);
  const receipt = receiptOf(
    await extension.tool(
      "arm",
      { action: "start", condition: "false" },
      new AbortController().signal,
      undefined,
      next.context().ctx
    )
  );
  await extension.shutdown("quit", next.context().ctx);
  const { claimHandoff } = await import("../src/handoff.ts");
  const result = await claimHandoff({
    directory,
    predecessorId: next.id,
    successorId: "next",
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    kind: "claimed",
    handoff: { suspension: { watches: [{ facts: { id: receipt.id } }] } },
  });
});
it.each([false, true])(
  "manual resume skips delivered/consumed terminal requests: %s",
  async (consumed) => {
    const session = new FakeSession();
    session.appendCustom(
      "pi-until-suspended",
      suspensionData([], Date.now(), "quit", session.id, [
        {
          kind: "terminal",
          id: "wake",
          watchId: "done",
          dedupeKey: "terminal:done:succeeded",
          customType: "pi-until",
          content: "inert",
          details: {},
        },
      ])
    );
    if (consumed)
      session.appendCustom("pi-until-wake-handled", {
        followUpId: "wake",
        disposition: "consumed",
      });
    const extension = loadExtension(session);
    extensions.push(extension);
    const resume = extension.commands.get("until-resume");
    if (!resume) throw new Error("missing command");
    await resume("", session.context().ctx);
    await extension.agentSettled(session.context().ctx);
    await resume("", session.context().ctx);
    expect(extension.messages).toHaveLength(consumed ? 0 : 1);
  }
);
it("fires a post-adoption tick at the original jittered due time", async () => {
  const { directory, session } = await setup();
  const clock = new SimulatedClock();
  const parent = loadExtension(session, { clock, handoff: { directory } });
  extensions.push(parent);
  const first = receiptOf(
    await parent.tool(
      "arm",
      {
        action: "repeat",
        intervalSeconds: 1,
        timeoutSeconds: 60,
        instruction: "Inert task",
        quickRef: "cursor:42",
      },
      new AbortController().signal,
      undefined,
      session.context().ctx
    )
  );
  if (!first.nextDueAt) throw new Error("missing initial due time");
  clock.increment(Date.parse(first.nextDueAt) - clock.now());
  await vi.waitFor(() => expect(parent.messages).toHaveLength(1));
  await parent.agentSettled(session.context().ctx);
  const afterFirst = receiptOf(
    await parent.tool(
      "status",
      { action: "status", id: first.id },
      new AbortController().signal,
      undefined,
      session.context().ctx
    )
  );
  if (!afterFirst.nextDueAt) throw new Error("missing second due time");
  const expectedDue = Date.parse(afterFirst.nextDueAt);
  await parent.shutdown("quit");
  const child = new FakeSession();
  const successor = loadExtension(child, {
    clock,
    handoff: { directory, predecessorId: session.id, successorId: child.id },
  });
  extensions.push(successor);
  await successor.sessionStart("startup", child.context().ctx);
  await vi.waitFor(async () =>
    expect(await listed(successor, child)).toEqual([first.id])
  );
  clock.increment(expectedDue - clock.now() - 1);
  expect(successor.messages).toHaveLength(0);
  clock.increment(1);
  await vi.waitFor(() => expect(successor.messages).toHaveLength(1));
  expect(clock.now()).toBe(expectedDue);
  expect(successor.messages[0]?.message.details).toMatchObject({
    receipt: { id: first.id, deliveries: 2 },
  });
});
it.each([true, false])(
  "binds the declaration to one session, never a later /resume (explicit: %s)",
  async (bound) => {
    const { directory, session, extension, data } = await setup(bound);
    await extension.sessionStart("startup", session.context().ctx);
    await extension.shutdown("resume");
    const unrelated = new FakeSession();
    await extension.sessionStart("resume", unrelated.context().ctx);
    await publishHandoff(directory, data);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(await listed(extension, unrelated)).toEqual([]);
    await expect(stat(join(directory, "parent.json"))).resolves.toBeDefined();
  }
);
it("publishes a fresh quit when a successor races same-session restoration", async () => {
  const { directory, session: parent } = await setup();
  const first = loadExtension(parent, { handoff: { directory } });
  extensions.push(first);
  const watch = receiptOf(
    await first.tool(
      "arm",
      { action: "start", condition: "false", intervalSeconds: 60 },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  await first.shutdown("quit");
  const prior = newestSuspension(parent.entries);
  if (!prior?.suspendedAt) throw new Error("missing quit");
  const time = Date.parse(prior.suspendedAt);
  parent.appendCustom(
    "other-extension-startup",
    {},
    new Date(time + 1).toISOString()
  );
  const child = new FakeSession(new Date(time + 2).toISOString());
  child.entries.push(...parent.entries);
  const successor = loadExtension(child, {
    handoff: { directory, predecessorId: parent.id, successorId: child.id },
  });
  extensions.push(successor);
  await successor.sessionStart("startup", child.context().ctx);
  const restored = loadExtension(parent, {
    clock: { ...systemClock, now: () => Date.now() + 10000 },
    handoff: { directory },
  });
  extensions.push(restored);
  const starting = restored.sessionStart("startup", parent.context().ctx);
  await restored.shutdown("quit");
  await starting;
  expect(
    Date.parse(newestSuspension(parent.entries)?.suspendedAt ?? "")
  ).toBeGreaterThan(time + 1);
  await vi.waitFor(async () =>
    expect(await listed(successor, child)).toEqual([watch.id])
  );
});
it("carries unrestored work forward when quit races startup", async () => {
  const { directory, session, data } = await setup();
  session.appendCustom("pi-until-suspended", {
    ...data,
    sessionId: session.id,
  });
  await publishHandoff(directory, { ...data, sessionId: session.id });
  const startingOwner = loadExtension(session, { handoff: { directory } });
  extensions.push(startingOwner);
  const starting = startingOwner.sessionStart("startup", session.context().ctx);
  await startingOwner.shutdown("quit");
  await starting;
  expect(newestSuspension(session.entries)?.watches).toEqual(data.watches);
  const next = loadExtension(session, { handoff: { directory } });
  extensions.push(next);
  await next.sessionStart("startup", session.context().ctx);
  expect(await listed(next, session)).toEqual(["watch"]);
});
it("refuses an inherited-env RPC child on fallback", async () => {
  const { directory, session, data } = await setup();
  const extension = loadExtension(session, {
    handoff: {
      directory,
      predecessorId: "parent",
      waitMs: 40,
    },
    environment: { PI_SESSION_ID: "bash-parent" },
  });
  extensions.push(extension);
  await publishHandoff(directory, data);
  await extension.sessionStart("startup", session.context({ mode: "rpc" }).ctx);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
  expect(await listed(extension, session)).toEqual([]);
});
it.each([false, true])(
  "rearms a bound wait after reload, including interrupted rename: %s",
  async (interrupted) => {
    const { directory, session, extension, data, handoff } = await setup();
    await extension.sessionStart("startup", session.context().ctx);
    await extension.shutdown("reload");
    if (interrupted) {
      const { claimHandoff } = await import("../src/handoff.ts");
      await publishHandoff(directory, data);
      await claimHandoff({
        ...handoff,
        successorId: session.id,
        signal: new AbortController().signal,
      });
    }
    const reloaded = loadExtension(session, { handoff: { directory } });
    extensions.push(reloaded);
    await reloaded.sessionStart("reload", session.context().ctx);
    if (!interrupted) await publishHandoff(directory, data);
    await vi.waitFor(async () =>
      expect(await listed(reloaded, session)).toEqual(["watch"])
    );
    const markers = session.entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-until-resumed" &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "predecessorId" in entry.data
    );
    expect(markers).toHaveLength(1);
  }
);
