import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";

import { initialFacts } from "../src/domain.ts";
import type {
  RecurringDefinition,
  UntilDefinition,
  WatchActorInput,
  WatchFacts,
} from "../src/domain.ts";
import { createWatchMachine } from "../src/machine.ts";
import type { RunUntilCheck, WatchTerminalState } from "../src/machine.ts";

const untilDefinition = (
  overrides: Partial<UntilDefinition> = {}
): UntilDefinition => ({
  gate: {
    checkTimeoutMs: 100,
    command: "true",
    cwd: process.cwd(),
  },
  intervalMs: 5,
  kind: "until",
  label: "test condition",
  wake: "agent",
  ...overrides,
});

const recurringDefinition = (
  overrides: Partial<RecurringDefinition> = {}
): RecurringDefinition => ({
  expiresAt: 100,
  first: "now",
  intervalMs: 5,
  kind: "recurring",
  label: "recurring test",
  snapshot: {
    capturedAt: 0,
    contextRefs: [],
    instruction: "Check the work.",
    origin: { sessionId: "s1" },
    quickRef: "test",
  },
  ...overrides,
});

const input = (
  definition: UntilDefinition | RecurringDefinition,
  facts: Partial<WatchFacts> = {},
  sessionIdle = true
): WatchActorInput => ({
  definition,
  facts: {
    ...initialFacts(definition, "test", 0),
    ...facts,
  },
  sessionIdle,
});

async function waitForDone(
  actor: ReturnType<typeof createActor<ReturnType<typeof createWatchMachine>>>
): Promise<WatchTerminalState> {
  return new Promise((resolve, reject) => {
    const subscription = actor.subscribe({
      error: reject,
      next(snapshot) {
        if (snapshot.status !== "done") return;
        subscription.unsubscribe();
        const value = snapshot.value;
        if (
          value === "satisfied" ||
          value === "completed" ||
          value === "expired" ||
          value === "cancelled"
        ) {
          resolve(value);
        } else {
          reject(new Error(`unexpected terminal state: ${String(value)}`));
        }
      },
    });
  });
}

describe("pi-until watch machine", () => {
  it("polls until a gate exits zero", async () => {
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValueOnce({ code: 1, killed: false })
      .mockResolvedValueOnce({ code: 0, killed: false });
    const startedAt = Date.now();
    const definition = untilDefinition();
    const actor = createActor(createWatchMachine(runCheck), {
      input: input(definition, {
        nextDueAt: startedAt,
        startedAt,
      }),
    });
    const done = waitForDone(actor);

    actor.start();

    await expect(done).resolves.toBe("satisfied");
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().context.facts.attempts).toBe(2);
    expect(actor.getSnapshot().context.facts.lastResult).toEqual({
      code: 0,
      killed: false,
    });
  });

  it("does not treat a killed gate with code zero as true", async () => {
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValueOnce({ code: 0, killed: true })
      .mockResolvedValueOnce({ code: 0, killed: false });
    const startedAt = Date.now();
    const definition = untilDefinition();
    const actor = createActor(createWatchMachine(runCheck), {
      input: input(definition, { nextDueAt: startedAt, startedAt }),
    });
    const done = waitForDone(actor);

    actor.start();

    await expect(done).resolves.toBe("satisfied");
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight gate through AbortSignal", async () => {
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
    const startedAt = Date.now();
    const definition = untilDefinition();
    const actor = createActor(createWatchMachine(runCheck), {
      input: input(definition, { nextDueAt: startedAt, startedAt }),
    });
    const done = waitForDone(actor);

    actor.start();
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.facts.attempts).toBe(1);
    });
    actor.send({ type: "CANCEL" });

    await expect(done).resolves.toBe("cancelled");
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
  });

  it("expires independently from cancellation", async () => {
    const startedAt = Date.now();
    const definition = untilDefinition({ expiresAt: startedAt + 5 });
    const runCheck = vi
      .fn<RunUntilCheck>()
      .mockResolvedValue({ code: 1, killed: false });
    const actor = createActor(createWatchMachine(runCheck), {
      input: input(definition, { nextDueAt: startedAt, startedAt }),
    });
    const done = waitForDone(actor);

    actor.start();

    await expect(done).resolves.toBe("expired");
  });

  it("coalesces fixed-cadence ticks while one follow-up is pending", async () => {
    let now = 0;
    const definition = recurringDefinition();
    const actor = createActor(
      createWatchMachine(vi.fn<RunUntilCheck>(), () => now),
      { input: input(definition, {}, false) }
    );

    actor.start();
    expect(actor.getSnapshot().matches({ active: "duePending" })).toBe(true);
    expect(actor.getSnapshot().context.facts.deliveries).toBe(0);

    now = 1;
    actor.send({ at: now, type: "SESSION_SETTLED" });
    expect(actor.getSnapshot().matches({ active: "awaitingSettlement" })).toBe(
      true
    );
    expect(actor.getSnapshot().context.facts).toMatchObject({
      deliveries: 1,
      missedTicks: 0,
      nextDueAt: 5,
    });

    now = 16;
    actor.send({ at: now, type: "SESSION_SETTLED" });
    expect(actor.getSnapshot().matches({ active: "waiting" })).toBe(true);
    expect(actor.getSnapshot().context.facts).toMatchObject({
      deliveries: 1,
      missedTicks: 3,
      nextDueAt: 20,
    });
  });
});
