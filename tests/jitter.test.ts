import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createActor, SimulatedClock } from "xstate";

import {
  advanceAfterTick,
  coalescePastDue,
  dueAt,
  initialFacts,
  phaseOffsetMs,
  watchDefinitionSchema,
} from "../src/domain.ts";
import type {
  RecurringDefinition,
  UntilDefinition,
  WatchFacts,
} from "../src/domain.ts";
import type { UntilJitter } from "../src/jitter.ts";
import { createWatchMachine } from "../src/machine.ts";
import type { RunUntilCheck } from "../src/machine.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 5, 7, 0, 0);

const recurring = (
  overrides: Partial<RecurringDefinition> = {}
): RecurringDefinition => ({
  expiresAt: START + 10_000 * MINUTE,
  first: "afterInterval",
  intervalMs: MINUTE,
  kind: "recurring",
  label: "desk pass",
  snapshot: {
    capturedAt: START,
    contextRefs: [],
    instruction: "Run the desk pass.",
    origin: { sessionId: "s1" },
    quickRef: "desk pass",
  },
  ...overrides,
});

const until = (overrides: Partial<UntilDefinition> = {}): UntilDefinition => ({
  gate: { checkTimeoutMs: 1_000, command: "false", cwd: process.cwd() },
  intervalMs: 1_000,
  kind: "until",
  label: "ci",
  wake: "agent",
  ...overrides,
});

/** Deliver every tick the moment it falls due, as an idle session would. */
const simulateTicks = (
  definition: RecurringDefinition,
  id: string,
  ticks: number
) => {
  let facts: WatchFacts = initialFacts(definition, id, START);
  const fires: { anchor: number; at: number }[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const at = dueAt(definition, facts);
    fires.push({ anchor: facts.nextDueAt, at });
    facts = advanceAfterTick(facts, definition.intervalMs, at);
  }
  return { facts, fires };
};

describe("pi-until schedule jitter", () => {
  it("spreads 1,000 recurring ticks around a cadence that does not drift", () => {
    const definition = recurring();
    const { facts, fires } = simulateTicks(definition, "a1b2c3d4", 1_001);

    const phase = phaseOffsetMs(definition, "a1b2c3d4");
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(0.2 * MINUTE);
    expect(fires[0]?.at).toBe(START + MINUTE + phase);

    for (const [tick, fire] of fires.entries()) {
      expect(fire.anchor).toBe(START + MINUTE + phase + tick * MINUTE);
      expect(Math.abs(fire.at - fire.anchor)).toBeLessThanOrEqual(0.1 * MINUTE);
    }

    const gaps = fires.slice(1).map((fire, index) => {
      const previous = fires[index];
      if (previous === undefined) throw new Error("missing previous fire");
      return fire.at - previous.at;
    });
    expect(gaps).toHaveLength(1_000);
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    expect(Math.abs(mean - MINUTE)).toBeLessThan(0.01 * MINUTE);
    // The spread is real, not a constant shift.
    expect(Math.min(...gaps)).toBeLessThan(0.95 * MINUTE);
    expect(Math.max(...gaps)).toBeGreaterThan(1.05 * MINUTE);
    expect(facts.missedTicks).toBe(0);
  });

  it("gives watches started together different first wakes, stable per id", () => {
    const definition = recurring();
    const ids = ["0f3a9c21", "7d44e8b0", "c19e2a5f"];
    const firstWakes = ids.map(
      (id) => initialFacts(definition, id, START).nextDueAt
    );

    expect(new Set(firstWakes).size).toBe(ids.length);
    for (const [index, id] of ids.entries()) {
      expect(initialFacts(definition, id, START + 5_000).nextDueAt).toBe(
        (firstWakes[index] ?? 0) + 5_000
      );
    }
  });

  it("still wakes an immediate repeat and an until check at once", () => {
    const now = recurring({ first: "now" });
    expect(dueAt(now, initialFacts(now, "0f3a9c21", START))).toBe(START);
    const check = until();
    expect(dueAt(check, initialFacts(check, "0f3a9c21", START))).toBe(START);
  });

  it("counts the same missed ticks for a long sleep with or without jitter", () => {
    for (const jitter of [undefined, false] as const) {
      const definition =
        jitter === undefined ? recurring() : recurring({ jitter });
      const first = initialFacts(definition, "7d44e8b0", START);
      const firedAt = dueAt(definition, first);
      // The session sleeps ten and a half intervals after the first tick.
      const awoke = firedAt + 10.5 * MINUTE;
      const afterTick = advanceAfterTick(first, MINUTE, awoke);
      expect(afterTick.missedTicks).toBe(10);
      expect(afterTick.nextDueAt).toBe(first.nextDueAt + 11 * MINUTE);

      const coalesced = coalescePastDue(
        { ...first, nextDueAt: first.nextDueAt + MINUTE },
        MINUTE,
        awoke
      );
      expect(coalesced.missedTicks).toBe(10);
      expect(coalesced.nextDueAt).toBe(first.nextDueAt + 11 * MINUTE);
    }
  });

  it("reproduces exact cadence with jitter: false", () => {
    const definition = recurring({ jitter: false });
    const { fires } = simulateTicks(definition, "c19e2a5f", 50);
    for (const [tick, fire] of fires.entries()) {
      expect(fire.at).toBe(START + (tick + 1) * MINUTE);
    }
  });

  it("jitters a watch saved before jitter existed", () => {
    const legacy = recurring();
    expect("jitter" in legacy).toBe(false);
    expect(Value.Check(watchDefinitionSchema, legacy)).toBe(true);
    const facts: WatchFacts = {
      ...initialFacts(legacy, "c19e2a5f", START),
      nextDueAt: START + 5 * MINUTE,
    };
    const due = dueAt(legacy, facts);
    expect(due).not.toBe(facts.nextDueAt);
    expect(Math.abs(due - facts.nextDueAt)).toBeLessThanOrEqual(0.1 * MINUTE);
    expect(dueAt(legacy, facts)).toBe(due);
  });

  it("draws spread only from the injected source", () => {
    const early: UntilJitter = { unit: () => 0 };
    const late: UntilJitter = { unit: () => 0.999_999 };
    const definition = recurring();
    const facts: WatchFacts = {
      ...initialFacts(definition, "id", START, early),
      nextDueAt: START + 3 * MINUTE,
    };

    expect(initialFacts(definition, "id", START, early).nextDueAt).toBe(
      START + MINUTE
    );
    expect(initialFacts(definition, "id", START, late).nextDueAt).toBe(
      START + MINUTE + Math.floor(0.999_999 * 0.2 * MINUTE)
    );
    expect(dueAt(definition, facts, early)).toBe(facts.nextDueAt - 6_000);
    expect(dueAt(definition, facts, late)).toBe(facts.nextDueAt + 6_000);
  });

  it("spaces until checks within ±10% of the interval", async () => {
    const clock = new SimulatedClock();
    const checkedAt: number[] = [];
    const runCheck = vi.fn<RunUntilCheck>(async () => {
      checkedAt.push(clock.now());
      return { code: 1, killed: false };
    });
    const definition = until();
    const actor = createActor(createWatchMachine(runCheck, clock), {
      clock,
      input: {
        definition,
        facts: initialFacts(definition, "0f3a9c21", clock.now()),
      },
    });
    actor.start();

    const stepMs = 10;
    while (checkedAt.length < 40) {
      // oxlint-disable-next-line no-await-in-loop -- Each step must settle before the clock moves.
      await vi.waitFor(() => {
        expect(actor.getSnapshot().matches({ active: "waiting" })).toBe(true);
      });
      clock.increment(stepMs);
    }
    actor.send({ type: "CANCEL" });

    const gaps = checkedAt
      .slice(1)
      .map((at, index) => at - (checkedAt[index] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(900);
      expect(gap).toBeLessThanOrEqual(1_100 + stepMs);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });
});
