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
import { SimulatedClock } from "xstate";

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

describe("pi-until extension", () => {
  it("returns immediately and wakes the agent after a later successful check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-extension-"));
    const readyFile = join(directory, "ready");
    tempDirectories.push(directory);
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx, setWidget } = session.context();

    const result = await extension.tool(
      "tool-call",
      {
        action: "start",
        condition: `test -f ${JSON.stringify(readyFile)}`,
        intervalSeconds: 1,
        label: "integration test",
        wake: "agent",
      },
      new AbortController().signal,
      undefined,
      ctx
    );

    expect(result.details).toMatchObject({ reloads: 0, status: "running" });
    expect(setWidget).toHaveBeenCalledWith(
      "pi-until-watches",
      expect.any(Function)
    );
    const { id } = receiptOf(result);
    expect(extension.messages).toHaveLength(0);
    writeFileSync(readyFile, "ready\n", "utf-8");

    await vi.waitFor(
      () => {
        expect(extension.messages).toHaveLength(1);
      },
      { timeout: 2_000 }
    );
    const lastWidgetCall = setWidget.mock.calls.at(-1);
    expect(lastWidgetCall?.[0]).toBe("pi-until-watches");
    expect(lastWidgetCall?.[1]).toBeUndefined();

    const [sent] = extension.messages;
    expect(sent?.message.customType).toBe("pi-until");
    expect(sent?.message.content).toContain("condition is true");
    expect(sent?.message.content).not.toContain(readyFile);
    expect(sent?.message.content).not.toContain("stdout");
    expect(sent?.message.content).not.toContain("Survived reloads");
    expect(sent?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });

    const firstStatus = await extension.tool(
      "status-1",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    await sleep(5);
    const secondStatus = await extension.tool(
      "status-2",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(receiptOf(firstStatus)).toMatchObject({ status: "succeeded" });
    expect(receiptOf(firstStatus).finishedAt).toBeDefined();
    expect(receiptOf(firstStatus).finishedAt).toBe(
      receiptOf(secondStatus).finishedAt
    );

    const kinds = extension.telemetry.map((event) => event.event);
    expect(kinds).toEqual([
      "action",
      "started",
      "finished",
      "action",
      "action",
    ]);
    const started = extension.telemetry.find(
      (event) => event.event === "started"
    );
    expect(JSON.stringify(started)).not.toContain(readyFile);
    expect(started).toMatchObject({ resumed: false });
    expect(started).not.toHaveProperty("conditionHead");
  });

  it("supports notify-only completion without waking the agent", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx, notify } = session.context();

    await extension.tool(
      "notify-watch",
      { action: "start", condition: "true", label: "quiet", wake: "notify" },
      new AbortController().signal,
      undefined,
      ctx
    );

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith("quiet: condition met", "info");
    });
    expect(extension.sendMessage).not.toHaveBeenCalled();
    const finished = extension.entries.find(
      (entry) => entry.customType === "pi-until-finished"
    );
    expect(finished?.data).toMatchObject({ status: "succeeded" });
    expect(finished?.data).not.toHaveProperty("lastOutput");
  });

  it("records a cancel in telemetry but not as a finished receipt", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context();
    const started = await extension.tool(
      "cancel-watch",
      { action: "start", condition: "false", intervalSeconds: 60, label: "c" },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    const cancelled = await extension.tool(
      "cancel",
      { action: "cancel", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(cancelled.details).toMatchObject({ status: "cancelled" });
    expect(extension.sendMessage).not.toHaveBeenCalled();
    expect(
      extension.entries.some(
        (entry) => entry.customType === "pi-until-finished"
      )
    ).toBe(false);
    expect(extension.telemetry).toContainEqual(
      expect.objectContaining({ event: "finished", status: "cancelled" })
    );
  });

  it("delivers an immutable Markdown follow-up after the current turn", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: false });
    const opaqueTarget = "  custom://release context?view=raw  ";

    const started = await extension.tool(
      "repeat",
      {
        action: "repeat",
        contextRefs: [{ label: "Runbook", target: opaqueTarget }],
        immediate: true,
        instruction: "Review the deployment and fix remaining failures.",
        intervalSeconds: 60,
        quickRef: "Release 42 verification",
        timeoutSeconds: 3_600,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    expect(extension.messages).toHaveLength(0);

    const { ctx: idleCtx } = session.context({ idle: true });
    await extension.agentSettled(idleCtx);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });

    const [sent] = extension.messages;
    expect(sent?.message.content).toContain("# Recurring follow-up");
    expect(sent?.message.content).toContain(
      "Review the deployment and fix remaining failures."
    );
    expect(sent?.message.content).toContain("Release 42 verification");
    expect(sent?.message.content).toContain(`Runbook: \`${opaqueTarget}\``);
    expect(JSON.stringify(extension.entries)).toContain(opaqueTarget);
    expect(sent?.message.content).toContain("origin-entry");
    expect(sent?.message.content).toContain(`action=complete`);
    expect(sent?.message.content).toContain(`id=${id}`);
    expect(sent?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(JSON.stringify(extension.telemetry)).not.toContain(
      "Review the deployment"
    );
    expect(JSON.stringify(extension.telemetry)).not.toContain(
      "Release 42 verification"
    );
    expect(JSON.stringify(extension.telemetry)).not.toContain(opaqueTarget);

    const completed = await extension.tool(
      "complete",
      { action: "complete", id },
      new AbortController().signal,
      undefined,
      idleCtx
    );
    expect(completed.details).toMatchObject({
      deliveries: 1,
      kind: "recurring",
      status: "completed",
    });
    expect(extension.messages).toHaveLength(1);
  });

  it("queues only one recurring follow-up for the whole Pi session", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: false });

    await Promise.all(
      ["first", "second"].map((name) =>
        extension.tool(
          `repeat-${name}`,
          {
            action: "repeat",
            immediate: true,
            instruction: `Run the ${name} follow-up.`,
            intervalSeconds: 60,
            quickRef: name,
            timeoutSeconds: 600,
          },
          new AbortController().signal,
          undefined,
          ctx
        )
      )
    );

    await extension.agentSettled(ctx);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    expect(extension.messages[0]?.message.content).toContain("first follow-up");

    await extension.agentSettled(ctx);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(2);
    });
    expect(extension.messages[1]?.message.content).toContain(
      "second follow-up"
    );
  });

  it("pauses the session queue until a delayed message start is reconciled", async () => {
    const clock = new SimulatedClock();
    const session = new FakeSession();
    const extension = loadExtension(session, {
      acknowledgeMessages: false,
      clock,
      followUpDispatchAckMs: 5_000,
    });
    live.push(extension);
    const { ctx, notify } = session.context({ idle: false });
    const started = await extension.tool(
      "unacknowledged",
      {
        action: "repeat",
        immediate: true,
        instruction: "This delivery starts late.",
        intervalSeconds: 60,
        quickRef: "delayed delivery",
        timeoutSeconds: 600,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await extension.tool(
      "waiting-behind-unacknowledged",
      {
        action: "repeat",
        immediate: true,
        instruction: "This delivery must wait.",
        intervalSeconds: 60,
        quickRef: "second delivery",
        timeoutSeconds: 600,
      },
      new AbortController().signal,
      undefined,
      ctx
    );

    await extension.agentSettled(ctx);
    expect(extension.messages).toHaveLength(1);
    expect(extension.messages[0]?.message.content).toContain(
      `- Next due: ${new Date(60_000).toISOString()}`
    );
    clock.increment(5_000);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("delivery queue is paused"),
      "warning"
    );
    const pending = await extension.tool(
      "unacknowledged-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(pending.details).toMatchObject({
      deliveries: 0,
      deliveryPending: true,
      status: "running",
    });
    expect(extension.messages).toHaveLength(1);

    clock.increment(60_000);
    await extension.acknowledgeMessage(0, ctx);
    const startedLate = await extension.tool(
      "late-start-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(startedLate.details).toMatchObject({
      deliveries: 1,
      missedTicks: 0,
      nextDueAt: new Date(60_000).toISOString(),
    });

    await extension.agentSettled(ctx);
    expect(extension.messages).toHaveLength(2);
    const reconciled = await extension.tool(
      "reconciled-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(reconciled.details).toMatchObject({
      deliveries: 1,
      missedTicks: 1,
      nextDueAt: new Date(120_000).toISOString(),
    });
  });

  it("fails a recurring watch when Pi rejects dispatch synchronously", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session, {
      sendMessageFailure: new Error("send rejected"),
    });
    live.push(extension);
    const { ctx } = session.context({ idle: false });
    const started = await extension.tool(
      "rejected-dispatch",
      {
        action: "repeat",
        immediate: true,
        instruction: "This message is rejected.",
        intervalSeconds: 60,
        quickRef: "rejected dispatch",
        timeoutSeconds: 600,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);

    await extension.agentSettled(ctx);
    const failed = await extension.tool(
      "rejected-dispatch-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(failed.details).toMatchObject({
      defect: "Pi did not accept the follow-up message",
      status: "failed",
    });
  });

  it("retains only the newest 50 terminal receipts", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context();

    for (let index = 0; index < 55; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each watch must finish before the 32-watch cap is checked again.
      const started = await extension.tool(
        `bounded-${index}`,
        {
          action: "start",
          condition: "false",
          intervalSeconds: 60,
          label: `bounded-${index}`,
        },
        new AbortController().signal,
        undefined,
        ctx
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Cancellation makes room for the next watch.
      await extension.tool(
        `cancel-${index}`,
        { action: "cancel", id: receiptOf(started).id },
        new AbortController().signal,
        undefined,
        ctx
      );
    }

    const listed = await extension.tool(
      "bounded-list",
      { action: "list" },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(listed.details).toMatchObject({
      watches: expect.arrayContaining([
        expect.objectContaining({ label: "bounded-54" }),
      ]),
    });
    expect(
      listed.details && "watches" in listed.details
        ? listed.details.watches
        : []
    ).toHaveLength(50);
  });

  it("coalesces recurring ticks while a delivered follow-up is unsettled", async () => {
    const clock = new SimulatedClock();
    const session = new FakeSession();
    const extension = loadExtension(session, { clock });
    live.push(extension);
    const { ctx } = session.context({ idle: false });

    const started = await extension.tool(
      "repeat-coalescing",
      {
        action: "repeat",
        immediate: true,
        instruction: "Check again.",
        intervalSeconds: 1,
        quickRef: "coalescing test",
        timeoutSeconds: 10,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await extension.agentSettled(ctx);
    clock.increment(0);

    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    clock.increment(3_000);
    expect(extension.messages).toHaveLength(1);

    await extension.agentSettled(ctx);
    const status = await extension.tool(
      "repeat-status",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(receiptOf(status).deliveries).toBe(1);
    expect(receiptOf(status).missedTicks).toBeGreaterThanOrEqual(2);

    await extension.tool(
      "repeat-complete",
      { action: "complete", id },
      new AbortController().signal,
      undefined,
      ctx
    );
  });

  it("uses an optional shell gate without treating it as the action", async () => {
    const clock = new SimulatedClock();
    const directory = mkdtempSync(join(tmpdir(), "pi-until-repeat-gate-"));
    const readyFile = join(directory, "ready");
    tempDirectories.push(directory);
    const session = new FakeSession();
    const extension = loadExtension(session, { clock });
    live.push(extension);
    const { ctx } = session.context({ idle: true });

    const started = await extension.tool(
      "repeat-gated",
      {
        action: "repeat",
        condition: `test -f ${JSON.stringify(readyFile)}`,
        immediate: true,
        instruction: "Inspect the gated work.",
        intervalSeconds: 1,
        quickRef: "gated follow-up",
        timeoutSeconds: 10,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await sleep(10);
    expect(extension.messages).toHaveLength(0);

    writeFileSync(readyFile, "ready\n", "utf-8");
    clock.increment(1_000);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    expect(extension.messages[0]?.message.content).toContain(
      "Inspect the gated work."
    );

    await extension.tool(
      "repeat-gated-complete",
      { action: "complete", id },
      new AbortController().signal,
      undefined,
      ctx
    );
  });

  it("wakes once with a terminal receipt when a recurrence expires", async () => {
    const clock = new SimulatedClock();
    const session = new FakeSession();
    const extension = loadExtension(session, { clock });
    live.push(extension);
    const { ctx } = session.context({ idle: true });

    await extension.tool(
      "repeat-expiry",
      {
        action: "repeat",
        instruction: "This instruction must not be reactivated at expiry.",
        intervalSeconds: 100,
        quickRef: "expiry test",
        timeoutSeconds: 1,
      },
      new AbortController().signal,
      undefined,
      ctx
    );

    clock.increment(1_000);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    const [expired] = extension.messages;
    expect(expired?.message.content).toContain("# Recurring follow-up expired");
    expect(expired?.message.content).toContain(
      "This recurrence is no longer active"
    );
    expect(expired?.message.content).not.toContain(
      "This instruction must not be reactivated"
    );
  });

  it("requires a bounded immutable snapshot for repeat", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context();

    await expect(
      extension.tool(
        "repeat-invalid",
        {
          action: "repeat",
          instruction: "Check later.",
          quickRef: "missing deadline",
        },
        new AbortController().signal,
        undefined,
        ctx
      )
    ).rejects.toThrow(/timeoutSeconds/u);
  });

  it("rejects print and json modes", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ mode: "print" });
    await expect(
      extension.tool(
        "print",
        { action: "start", condition: "true" },
        new AbortController().signal,
        undefined,
        ctx
      )
    ).rejects.toThrow(/long-lived/u);
  });

  it.skipIf(process.platform === "win32")(
    "stops active watches and descendants on session shutdown without waking the agent",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-shutdown-"));
      const pidFile = join(directory, "child.pid");
      tempDirectories.push(directory);
      const session = new FakeSession();
      const extension = loadExtension(session);
      const { ctx } = session.context();

      await extension.tool(
        "shutdown-watch",
        {
          action: "start",
          condition: `(trap '' TERM HUP; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          label: "shutdown",
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
      await extension.shutdown("quit");

      await vi.waitFor(
        () => {
          expect(() => process.kill(childPid, 0)).toThrow();
        },
        { timeout: 2_000 }
      );
      expect(extension.sendMessage).not.toHaveBeenCalled();
      expect(
        extension.entries.some(
          (entry) => entry.customType === "pi-until-suspended"
        )
      ).toBe(false);
    }
  );
});
