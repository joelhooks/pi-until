import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { createUntilMachine } from "../src/machine.ts";
import type {
  RunUntilCheck,
  UntilInput,
  UntilTerminalState,
} from "../src/machine.ts";

function input(overrides: Partial<UntilInput> = {}): UntilInput {
  return {
    checkTimeoutMs: 100,
    command: "true",
    cwd: process.cwd(),
    id: "test",
    intervalMs: 5,
    label: "test condition",
    startedAt: Date.now(),
    wake: "agent",
    ...overrides,
  };
}

async function waitForDone(
  actor: ReturnType<typeof createActor<ReturnType<typeof createUntilMachine>>>
): Promise<UntilTerminalState> {
  return new Promise((resolve, reject) => {
    const subscription = actor.subscribe({
      error: reject,
      next(snapshot) {
        if (snapshot.status !== "done") return;
        subscription.unsubscribe();
        const value = snapshot.value;
        if (
          value === "succeeded" ||
          value === "timedOut" ||
          value === "cancelled"
        )
          resolve(value);
        else reject(new Error(`unexpected terminal state: ${String(value)}`));
      },
    });
  });
}

describe("pi-until machine", () => {
  it("polls until a check exits zero", async () => {
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValueOnce({
        code: 1,
        killed: false,
      })
      .mockResolvedValueOnce({
        code: 0,
        killed: false,
      });
    const actor = createActor(createUntilMachine(runCheck), { input: input() });
    const done = waitForDone(actor);

    actor.start();

    await expect(done).resolves.toBe("succeeded");
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().context.attempts).toBe(2);
    expect(actor.getSnapshot().context.lastResult).toEqual({
      code: 0,
      killed: false,
    });
  });

  it("does not treat a killed check with code zero as success", async () => {
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValueOnce({ code: 0, killed: true })
      .mockResolvedValueOnce({ code: 0, killed: false });
    const actor = createActor(createUntilMachine(runCheck), { input: input() });
    const done = waitForDone(actor);

    actor.start();

    await expect(done).resolves.toBe("succeeded");
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight check through AbortSignal", async () => {
    let aborted = false;
    const runCheck: RunUntilCheck = async (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true }
        );
      });
    const actor = createActor(createUntilMachine(runCheck), { input: input() });
    const done = waitForDone(actor);

    actor.start();
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.attempts).toBe(1);
    });
    actor.send({ type: "CANCEL" });

    await expect(done).resolves.toBe("cancelled");
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
  });

  it("separates watch timeout from cancellation", async () => {
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValue({ code: 1, killed: false });
    const actor = createActor(createUntilMachine(runCheck), { input: input() });
    const done = waitForDone(actor);

    actor.start();
    actor.send({ type: "TIMEOUT" });

    await expect(done).resolves.toBe("timedOut");
  });
});
