import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { systemClock } from "../src/clock.ts";
import type { UntilClock } from "../src/clock.ts";
import {
  RESUMED_ENTRY_TYPE,
  SUSPENDED_ENTRY_TYPE,
  newestSuspension,
  suspendedWatchesFrom,
  suspensionData,
} from "../src/suspension.ts";
import type { PersistedWatch } from "../src/suspension.ts";
import { FakeSession, loadExtension, receiptOf, sleep } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const tempDirectories: string[] = [];
const live: FakeExtension[] = [];

afterEach(async () => {
  await Promise.all(
    live.splice(0).map((extension) => extension.shutdown("quit"))
  );
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const startFileWatch = async (
  extension: FakeExtension,
  session: FakeSession,
  file: string,
  extra: { timeoutSeconds?: number } = {}
) => {
  const { ctx } = session.context();
  const result = await extension.tool(
    "start",
    {
      action: "start",
      condition: `test -f ${JSON.stringify(file)}`,
      intervalSeconds: 1,
      label: "reload test",
      ...extra,
    },
    new AbortController().signal,
    undefined,
    ctx
  );
  return { ctx, details: receiptOf(result) };
};

/** A system clock whose reading can jump ahead to simulate a long quit. */
const offsetClock = () => {
  const state = { offsetMs: 0 };
  const clock: UntilClock = {
    ...systemClock,
    now: () => Date.now() + state.offsetMs,
  };
  return { clock, state };
};

const startRecurring = async (
  extension: FakeExtension,
  session: FakeSession,
  extra: { timeoutSeconds?: number } = {}
) => {
  const { ctx } = session.context({ idle: true });
  const result = await extension.tool(
    "repeat",
    {
      action: "repeat",
      instruction: "Run the hawk tick.",
      intervalSeconds: 60,
      quickRef: "hawk tick",
      timeoutSeconds: 3_600,
      ...extra,
    },
    new AbortController().signal,
    undefined,
    ctx
  );
  return receiptOf(result);
};

const statusOf = async (
  extension: FakeExtension,
  id: string,
  ctx: ExtensionContext
) =>
  receiptOf(
    await extension.tool(
      "status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    )
  );

const listIds = async (extension: FakeExtension, ctx: ExtensionContext) => {
  const list = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  return list.details !== undefined && "watches" in list.details
    ? list.details.watches.map((receipt) => receipt.id)
    : [];
};

/** The raw newest suspension entry, for rewriting it into an older format. */
const newestSuspensionEntry = (session: FakeSession) => {
  const record = newestSuspension(session.entries);
  const entry = session.entries[record?.index ?? -1];
  if (entry?.type !== "custom") throw new Error("missing suspension entry");
  return entry;
};

const resumedMarkers = (session: FakeSession) =>
  session.entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === RESUMED_ENTRY_TYPE
  );

describe("pi-until across a quit and relaunch", () => {
  it("writes a quit entry that names its reason and session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 3_600 }
    );
    await first.shutdown("quit");

    expect(newestSuspension(session.entries)).toMatchObject({
      reason: "quit",
      sessionId: session.id,
      watches: [
        expect.objectContaining({
          facts: expect.objectContaining({ id: details.id, reloads: 1 }),
        }),
      ],
    });
    expect(first.telemetry).toContainEqual({ count: 1, event: "suspended" });
  });

  it("restores one-shot and recurring watches on the next startup with deadlines and cadence intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const readyFile = join(directory, "ready");
    const { clock, state } = offsetClock();
    const session = new FakeSession();

    const first = loadExtension(session, { clock });
    const { details: oneShot } = await startFileWatch(
      first,
      session,
      readyFile,
      { timeoutSeconds: 3_600 }
    );
    const recurring = await startRecurring(first, session);
    await sleep(30);
    await first.shutdown("quit");

    // Two and a half recurring intervals pass while Pi is closed.
    state.offsetMs = 150_000;
    const second = loadExtension(session, { clock });
    live.push(second);
    const { ctx, notify } = session.context({ idle: true });
    await second.sessionStart("startup", ctx);

    expect(notify).toHaveBeenCalledWith(
      "pi-until resumed 2 watches after Pi restarted this session",
      "info"
    );
    expect(second.telemetry).toContainEqual({ count: 2, event: "resumed" });
    expect(resumedMarkers(session)).toHaveLength(1);
    expect(resumedMarkers(session)[0]).toMatchObject({
      data: { resumed: 2, skippedExpired: 0 },
    });

    const restoredOneShot = await statusOf(second, oneShot.id, ctx);
    expect(restoredOneShot).toMatchObject({
      expiresAt: oneShot.expiresAt,
      reloads: 1,
      startedAt: oneShot.startedAt,
      status: "running",
    });

    // The overdue tick fires once, counts the missed tick, and the next due
    // time stays on the original one-minute grid.
    await vi.waitFor(() => {
      expect(
        second.messages.filter(
          (sent) => sent.message.customType === "pi-until-recurring"
        )
      ).toHaveLength(1);
    });
    expect(second.messages[0]?.message.content).toContain("Run the hawk tick.");
    const restoredRecurring = await statusOf(second, recurring.id, ctx);
    expect(restoredRecurring).toMatchObject({
      deliveries: 1,
      expiresAt: recurring.expiresAt,
      missedTicks: 1,
      startedAt: recurring.startedAt,
      status: "running",
    });
    expect(
      Date.parse(restoredRecurring.nextDueAt ?? "") -
        Date.parse(recurring.startedAt)
    ).toBe(180_000);

    // The recurring turn settles before the arbiter sends anything else.
    await second.agentSettled(ctx);
    await second.tool(
      "complete",
      { action: "complete", id: recurring.id },
      new AbortController().signal,
      undefined,
      ctx
    );
    // The one-shot checks once a second; give its next check room on slow CI.
    writeFileSync(readyFile, "ready\n", "utf-8");
    await vi.waitFor(
      () => {
        expect(
          second.messages.filter(
            (sent) => sent.message.customType === "pi-until"
          )
        ).toHaveLength(1);
      },
      { timeout: 3_000 }
    );
  });

  it("skips watches whose deadline passed while Pi was closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const { clock, state } = offsetClock();
    const session = new FakeSession();
    const first = loadExtension(session, { clock });
    await startFileWatch(first, session, join(directory, "never"), {
      timeoutSeconds: 60,
    });
    await first.shutdown("quit");

    state.offsetMs = 120_000;
    const second = loadExtension(session, { clock });
    live.push(second);
    const { ctx, notify } = session.context();
    await second.sessionStart("startup", ctx);

    expect(notify).toHaveBeenCalledWith("Skipped 1 expired watch", "warning");
    expect(await listIds(second, ctx)).toEqual([]);
    expect(resumedMarkers(session)[0]).toMatchObject({
      data: { resumed: 0, skippedExpired: 1 },
    });
    expect(second.messages).toHaveLength(0);
  });

  it("does not duplicate a watch the same instance already runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 3_600 }
    );
    await first.shutdown("quit");

    const second = loadExtension(session);
    live.push(second);
    const { ctx, notify } = session.context();
    await second.sessionStart("startup", ctx);
    expect(await listIds(second, ctx)).toEqual([details.id]);

    // The operator reaches for the old command anyway.
    notify.mockClear();
    const resume = second.commands.get("until-resume");
    if (!resume) throw new Error("until-resume command was not registered");
    await resume("", ctx);
    expect(notify).toHaveBeenCalledWith(
      "No suspended pi-until watches to resume (already active)",
      "warning"
    );
    expect(await listIds(second, ctx)).toEqual([details.id]);
  });

  it("drops duplicate ids inside one suspension entry", async () => {
    const session = new FakeSession();
    const watch: PersistedWatch = {
      definition: {
        expiresAt: Date.now() + 3_600_000,
        gate: { checkTimeoutMs: 1_000, command: "false", cwd: process.cwd() },
        intervalMs: 60_000,
        kind: "until",
        label: "twice",
        wake: "agent",
      },
      facts: {
        attempts: 1,
        deliveries: 0,
        deliveryPending: false,
        id: "twice001",
        missedTicks: 0,
        nextDueAt: Date.now() + 60_000,
        reloads: 1,
        startedAt: Date.now() - 1_000,
      },
    };
    session.appendCustom(
      SUSPENDED_ENTRY_TYPE,
      suspensionData([watch, watch], Date.now(), "quit", session.id)
    );
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx, notify } = session.context();
    await extension.sessionStart("startup", ctx);
    expect(notify).toHaveBeenCalledWith(
      "pi-until resumed 1 watch after Pi restarted this session",
      "info"
    );
    expect(await listIds(extension, ctx)).toEqual(["twice001"]);
  });

  it("consumes the entry so a crash cannot resurrect a watch the operator cancelled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 3_600 }
    );
    await first.shutdown("quit");

    const second = loadExtension(session);
    const { ctx } = session.context();
    await second.sessionStart("startup", ctx);
    await second.tool(
      "cancel",
      { action: "cancel", id: details.id },
      new AbortController().signal,
      undefined,
      ctx
    );
    // The second process dies without session_shutdown: no new entry.

    const third = loadExtension(session);
    live.push(third);
    const { ctx: thirdCtx, notify } = session.context();
    await third.sessionStart("startup", thirdCtx);
    expect(notify).not.toHaveBeenCalled();
    expect(await listIds(third, thirdCtx)).toEqual([]);
  });

  it("keeps a pending quit entry through a print-mode run of the same session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 3_600 }
    );
    await first.shutdown("quit");
    const entriesAfterQuit = session.entries.length;

    const printRun = loadExtension(session);
    const { ctx: printCtx, notify: printNotify } = session.context({
      mode: "print",
    });
    await printRun.sessionStart("startup", printCtx);
    session.appendUserMessage("one-shot question");
    await printRun.shutdown("quit", printCtx);
    expect(printNotify).not.toHaveBeenCalled();
    expect(
      session.entries
        .slice(entriesAfterQuit)
        .filter((entry) => entry.type === "custom")
    ).toEqual([]);

    const interactive = loadExtension(session);
    live.push(interactive);
    const { ctx } = session.context();
    await interactive.sessionStart("startup", ctx);
    expect(await listIds(interactive, ctx)).toEqual([details.id]);
  });

  it.each(["new", "fork"] as const)(
    "restores nothing on session_start %s",
    async (reason) => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
      tempDirectories.push(directory);
      const session = new FakeSession();
      const first = loadExtension(session);
      await startFileWatch(first, session, join(directory, "never"));
      await first.shutdown("quit");

      const next = loadExtension(session);
      live.push(next);
      const { ctx, notify } = session.context();
      await next.sessionStart(reason, ctx);
      expect(notify).not.toHaveBeenCalled();
      expect(await listIds(next, ctx)).toEqual([]);
      expect(resumedMarkers(session)).toHaveLength(0);
    }
  );

  it("restores nothing in a fork that copied the quit entry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const parent = new FakeSession();
    const first = loadExtension(parent);
    await startFileWatch(first, parent, join(directory, "never"), {
      timeoutSeconds: 3_600,
    });
    await first.shutdown("quit");

    const forked = parent.fork();
    const next = loadExtension(forked);
    live.push(next);
    const { ctx, notify } = forked.context();
    await next.sessionStart("startup", ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(await listIds(next, ctx)).toEqual([]);
  });

  it.each(["new", "resume", "fork"] as const)(
    "writes no suspension entry when %s replaces the session",
    async (reason) => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
      tempDirectories.push(directory);
      const session = new FakeSession();
      const first = loadExtension(session);
      await startFileWatch(first, session, join(directory, "never"));
      await first.shutdown(reason);
      expect(newestSuspension(session.entries)).toBeUndefined();
    }
  );

  it("restores a version 2 quit entry left by the previous release", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 3_600 }
    );
    await first.shutdown("quit");
    // Rewrite the entry the way pi-until 56f644e wrote it on quit.
    const entry = newestSuspensionEntry(session);
    entry.data = {
      suspendedAt: new Date().toISOString(),
      v: 2,
      watches: [...suspendedWatchesFrom(session.entries)],
    };

    const second = loadExtension(session);
    live.push(second);
    const { ctx } = session.context();
    await second.sessionStart("startup", ctx);
    expect(await listIds(second, ctx)).toEqual([details.id]);
  });

  it("leaves a version 2 entry alone once the conversation continued past it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    await startFileWatch(first, session, join(directory, "never"), {
      timeoutSeconds: 3_600,
    });
    await first.shutdown("reload");
    const entry = newestSuspensionEntry(session);
    entry.data = {
      suspendedAt: new Date().toISOString(),
      v: 2,
      watches: [...suspendedWatchesFrom(session.entries)],
    };
    session.appendUserMessage("work continued after the reload");

    const second = loadExtension(session);
    live.push(second);
    const { ctx, notify } = session.context();
    await second.sessionStart("startup", ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(await listIds(second, ctx)).toEqual([]);
  });

  it("still resumes explicitly with /until-resume when automatic recovery does not apply", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-restart-"));
    tempDirectories.push(directory);
    const readyFile = join(directory, "ready");
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(first, session, readyFile, {
      timeoutSeconds: 3_600,
    });
    // A reload entry, then the process died without a quit entry.
    await first.shutdown("reload");

    const second = loadExtension(session);
    live.push(second);
    const { ctx, notify } = session.context();
    await second.sessionStart("startup", ctx);
    expect(notify).not.toHaveBeenCalled();

    const resume = second.commands.get("until-resume");
    if (!resume) throw new Error("until-resume command was not registered");
    await resume("", ctx);
    expect(notify).toHaveBeenCalledWith(
      "pi-until resumed 1 watch from the newest suspension entry",
      "info"
    );
    expect(second.telemetry).toContainEqual({
      action: "resume",
      event: "action",
      source: "command",
    });
    expect(resumedMarkers(session)).toHaveLength(1);

    writeFileSync(readyFile, "ready\n", "utf-8");
    await vi.waitFor(
      () => {
        expect(second.messages).toHaveLength(1);
      },
      { timeout: 2_000 }
    );
    expect(second.messages[0]?.message.content).toContain(details.id);
  });
});

describe("pi-until across /reload", () => {
  it("suspends on reload, resumes in the new instance, and wakes the agent once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-reload-"));
    tempDirectories.push(directory);
    const readyFile = join(directory, "ready");
    const session = new FakeSession();

    const first = loadExtension(session);
    live.push(first);
    const { details } = await startFileWatch(first, session, readyFile);
    await sleep(30);

    await first.shutdown("reload");
    live.pop();

    const suspended = first.entries.find(
      (entry) => entry.customType === SUSPENDED_ENTRY_TYPE
    );
    expect(suspended).toBeDefined();
    expect(suspended?.data).toMatchObject({
      reason: "reload",
      sessionId: session.id,
      v: 3,
      watches: [
        expect.objectContaining({
          definition: expect.objectContaining({ wake: "agent" }),
          facts: expect.objectContaining({ id: details.id, reloads: 1 }),
        }),
      ],
    });
    const suspendedWatches = suspendedWatchesFrom(session.entries);
    const suspendedAttempts = suspendedWatches[0]?.facts.attempts ?? 0;
    expect(suspendedAttempts).toBeGreaterThan(0);
    expect(first.messages).toHaveLength(0);
    expect(first.telemetry).toContainEqual({ count: 1, event: "suspended" });

    const second = loadExtension(session);
    live.push(second);
    const { ctx, notify } = session.context();
    await second.sessionStart("reload", ctx);
    expect(notify).toHaveBeenCalledWith(
      "pi-until resumed 1 watch after reload",
      "info"
    );

    const status = await second.tool(
      "status",
      { action: "status", id: details.id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(status.details).toMatchObject({
      id: details.id,
      reloads: 1,
      status: "running",
    });
    expect(second.messages).toHaveLength(0);

    writeFileSync(readyFile, "ready\n", "utf-8");
    await vi.waitFor(
      () => {
        expect(second.messages).toHaveLength(1);
      },
      { timeout: 2_000 }
    );
    expect(second.messages[0]?.message.content).toContain(
      "Survived reloads: 1"
    );
    expect(second.messages[0]?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    const finished = second.telemetry.find(
      (event) => event.event === "finished"
    );
    expect(finished).toMatchObject({ reloads: 1, status: "succeeded" });
    expect(
      finished?.event === "finished" ? finished.attempts : 0
    ).toBeGreaterThan(suspendedAttempts);
    expect(first.messages).toHaveLength(0);
  });

  it("restores a recurring snapshot and its original fixed cadence", async () => {
    const session = new FakeSession();
    const first = loadExtension(session);
    const { ctx } = session.context({ idle: true });
    const started = await first.tool(
      "repeat-reload",
      {
        action: "repeat",
        contextRefs: [{ label: "Runbook", target: "docs/runbook.md" }],
        instruction: "Inspect the release after reload.",
        intervalSeconds: 1,
        quickRef: "reload recurrence",
        timeoutSeconds: 10,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await sleep(10);
    await first.shutdown("reload");
    expect(first.messages).toHaveLength(0);

    const second = loadExtension(session);
    live.push(second);
    const { ctx: resumedCtx } = session.context({ idle: true });
    await second.sessionStart("reload", resumedCtx);
    await vi.waitFor(
      () => {
        expect(second.messages).toHaveLength(1);
      },
      { timeout: 2_000 }
    );
    expect(second.messages[0]?.message.content).toContain(
      "Inspect the release after reload."
    );
    expect(second.messages[0]?.message.content).toContain("docs/runbook.md");

    const status = await second.tool(
      "repeat-reload-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      resumedCtx
    );
    expect(status.details).toMatchObject({
      deliveries: 1,
      reloads: 1,
      status: "running",
    });
    await second.tool(
      "repeat-reload-complete",
      { action: "complete", id },
      new AbortController().signal,
      undefined,
      resumedCtx
    );
  });

  it("preserves an approved gated delivery across reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-pending-reload-"));
    tempDirectories.push(directory);
    const gateFile = join(directory, "gate-open");
    writeFileSync(gateFile, "open\n", "utf-8");
    const session = new FakeSession();
    const first = loadExtension(session);
    const { ctx } = session.context({ idle: false });
    const started = await first.tool(
      "repeat-pending-reload",
      {
        action: "repeat",
        condition: `test -f ${JSON.stringify(gateFile)}`,
        immediate: true,
        instruction: "Deliver the already-approved follow-up.",
        intervalSeconds: 60,
        quickRef: "pending reload",
        timeoutSeconds: 600,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);

    await vi.waitFor(async () => {
      const status = await first.tool(
        "repeat-pending-status",
        { action: "status", id },
        new AbortController().signal,
        undefined,
        ctx
      );
      expect(status.details).toMatchObject({
        deliveryPending: true,
        status: "running",
      });
    });
    rmSync(gateFile);
    await first.shutdown("reload");

    const [persisted] = suspendedWatchesFrom(session.entries);
    expect(persisted?.facts.deliveryPending).toBe(true);

    const second = loadExtension(session);
    live.push(second);
    const { ctx: resumedCtx } = session.context({ idle: true });
    await second.sessionStart("reload", resumedCtx);
    await vi.waitFor(() => {
      expect(second.messages).toHaveLength(1);
    });
    expect(second.messages[0]?.message.content).toContain(
      "Deliver the already-approved follow-up."
    );
    expect(existsSync(gateFile)).toBe(false);

    await second.tool(
      "repeat-pending-complete",
      { action: "complete", id },
      new AbortController().signal,
      undefined,
      resumedCtx
    );
  });

  it("creates a fresh delivery arbiter when the same extension changes sessions", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: true });

    await extension.shutdown("new");
    await extension.sessionStart("new", ctx);
    await extension.tool(
      "new-session-watch",
      { action: "start", condition: "true", label: "new session" },
      new AbortController().signal,
      undefined,
      ctx
    );

    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    expect(extension.messages[0]?.message.content).toContain(
      "condition is true"
    );
  });

  it.each(["new", "resume", "fork", "startup"] as const)(
    "does not resurrect suspended watches on session_start %s",
    async (reason) => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-reload-"));
      tempDirectories.push(directory);
      const session = new FakeSession();
      const first = loadExtension(session);
      await startFileWatch(first, session, join(directory, "never"));
      await first.shutdown("reload");

      const next = loadExtension(session);
      live.push(next);
      const { ctx, notify } = session.context();
      await next.sessionStart(reason, ctx);
      expect(notify).not.toHaveBeenCalled();
      const list = await next.tool(
        "list",
        { action: "list" },
        new AbortController().signal,
        undefined,
        ctx
      );
      expect(list.details).toEqual({ watches: [] });
    }
  );

  it("writes an empty suspension on reload so an older entry cannot win", async () => {
    const session = new FakeSession();
    const stale = loadExtension(session);
    const directory = mkdtempSync(join(tmpdir(), "pi-until-reload-"));
    tempDirectories.push(directory);
    await startFileWatch(stale, session, join(directory, "never"));
    await stale.shutdown("reload");

    const middle = loadExtension(session);
    const { ctx: middleCtx } = session.context();
    await middle.sessionStart("reload", middleCtx);
    const staleId = suspendedWatchesFrom(session.entries)[0]?.facts.id ?? "";
    await middle.tool(
      "cancel",
      { action: "cancel", id: staleId },
      new AbortController().signal,
      undefined,
      middleCtx
    );
    await middle.shutdown("reload");
    expect(suspendedWatchesFrom(session.entries)).toEqual([]);

    const last = loadExtension(session);
    live.push(last);
    const { ctx, notify } = session.context();
    await last.sessionStart("reload", ctx);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the overall timeout anchored to the original start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-reload-"));
    tempDirectories.push(directory);
    const session = new FakeSession();
    const first = loadExtension(session);
    const { details } = await startFileWatch(
      first,
      session,
      join(directory, "never"),
      { timeoutSeconds: 1 }
    );
    await sleep(300);
    await first.shutdown("reload");
    expect(first.messages).toHaveLength(0);
    // The deadline passes while no instance is running. Resume must honour
    // the original start, not hand the watch a fresh second.
    await sleep(800);
    const second = loadExtension(session);
    live.push(second);
    const { ctx } = session.context();
    await second.sessionStart("reload", ctx);
    await vi.waitFor(() => {
      expect(second.messages).toHaveLength(1);
    });
    expect(second.messages[0]?.message.content).toContain(
      `watch ${details.id}: timedOut`
    );
  });

  it.skipIf(process.platform === "win32")(
    "terminates the in-flight check's descendants on reload before resuming",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-reload-"));
      tempDirectories.push(directory);
      const pidFile = join(directory, "child.pid");
      const session = new FakeSession();
      const first = loadExtension(session);
      const { ctx } = session.context();
      await first.tool(
        "start",
        {
          action: "start",
          condition: `(trap '' TERM HUP; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          label: "descendants",
        },
        new AbortController().signal,
        undefined,
        ctx
      );
      await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
      });
      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      await first.shutdown("reload");
      await vi.waitFor(
        () => {
          expect(() => process.kill(childPid, 0)).toThrow();
        },
        { timeout: 2_000 }
      );
      const suspended = first.entries.find(
        (entry) => entry.customType === SUSPENDED_ENTRY_TYPE
      );
      expect(suspended?.data).toMatchObject({
        watches: [
          expect.objectContaining({
            definition: expect.objectContaining({ label: "descendants" }),
          }),
        ],
      });
    }
  );
});
