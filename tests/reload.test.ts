import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SUSPENDED_ENTRY_TYPE,
  suspendedWatchesFrom,
} from "../src/suspension.ts";
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
      intervalSeconds: 0.01,
      label: "reload test",
      ...extra,
    },
    new AbortController().signal,
    undefined,
    ctx
  );
  return { ctx, details: receiptOf(result) };
};

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
      v: 2,
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
    await vi.waitFor(() => {
      expect(second.messages).toHaveLength(1);
    });
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
        intervalSeconds: 0.05,
        quickRef: "reload recurrence",
        timeoutSeconds: 1,
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
    await vi.waitFor(() => {
      expect(second.messages).toHaveLength(1);
    });
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
