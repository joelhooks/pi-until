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
        intervalSeconds: 0.005,
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

    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
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
    expect(started).toMatchObject({ conditionHead: "test", resumed: false });
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

  it("coalesces recurring ticks while a delivered follow-up is unsettled", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: false });

    const started = await extension.tool(
      "repeat-coalescing",
      {
        action: "repeat",
        instruction: "Check again.",
        intervalSeconds: 0.02,
        quickRef: "coalescing test",
        timeoutSeconds: 1,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await extension.agentSettled(ctx);

    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    await sleep(70);
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
    const directory = mkdtempSync(join(tmpdir(), "pi-until-repeat-gate-"));
    const readyFile = join(directory, "ready");
    tempDirectories.push(directory);
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: true });

    const started = await extension.tool(
      "repeat-gated",
      {
        action: "repeat",
        condition: `test -f ${JSON.stringify(readyFile)}`,
        immediate: true,
        instruction: "Inspect the gated work.",
        intervalSeconds: 0.02,
        quickRef: "gated follow-up",
        timeoutSeconds: 1,
      },
      new AbortController().signal,
      undefined,
      ctx
    );
    const { id } = receiptOf(started);
    await sleep(10);
    expect(extension.messages).toHaveLength(0);

    writeFileSync(readyFile, "ready\n", "utf-8");
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
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: true });

    await extension.tool(
      "repeat-expiry",
      {
        action: "repeat",
        instruction: "This instruction must not be reactivated at expiry.",
        intervalSeconds: 0.1,
        quickRef: "expiry test",
        timeoutSeconds: 0.02,
      },
      new AbortController().signal,
      undefined,
      ctx
    );

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
