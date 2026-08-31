import { Type } from "typebox";
import type { Static } from "typebox";

type DeepReadonly<Value> = Value extends readonly unknown[]
  ? readonly DeepReadonly<Value[number]>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export const contextRefSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 120 }),
    target: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false }
);

export type ContextRef = DeepReadonly<Static<typeof contextRefSchema>>;

export const shellGateSchema = Type.Object(
  {
    checkTimeoutMs: Type.Number({ minimum: 1 }),
    command: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type ShellGate = DeepReadonly<Static<typeof shellGateSchema>>;

const untilDefinitionSchema = Type.Object(
  {
    expiresAt: Type.Optional(Type.Number()),
    gate: shellGateSchema,
    intervalMs: Type.Number({ minimum: 1 }),
    kind: Type.Literal("until"),
    label: Type.String({ minLength: 1 }),
    wake: Type.Union([Type.Literal("agent"), Type.Literal("notify")]),
  },
  { additionalProperties: false }
);

export const followUpSnapshotSchema = Type.Object(
  {
    capturedAt: Type.Number(),
    contextRefs: Type.Array(contextRefSchema, { maxItems: 16 }),
    instruction: Type.String({ minLength: 1, maxLength: 20_000 }),
    origin: Type.Object(
      {
        entryId: Type.Optional(Type.String()),
        sessionId: Type.String(),
      },
      { additionalProperties: false }
    ),
    quickRef: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false }
);

export type FollowUpSnapshot = DeepReadonly<
  Static<typeof followUpSnapshotSchema>
>;

const recurringDefinitionSchema = Type.Object(
  {
    expiresAt: Type.Number(),
    first: Type.Union([Type.Literal("afterInterval"), Type.Literal("now")]),
    gate: Type.Optional(shellGateSchema),
    intervalMs: Type.Number({ minimum: 1 }),
    kind: Type.Literal("recurring"),
    label: Type.String({ minLength: 1 }),
    snapshot: followUpSnapshotSchema,
  },
  { additionalProperties: false }
);

export const watchDefinitionSchema = Type.Union([
  untilDefinitionSchema,
  recurringDefinitionSchema,
]);

export type WatchDefinition = DeepReadonly<
  Static<typeof watchDefinitionSchema>
>;
export type UntilDefinition = Extract<WatchDefinition, { kind: "until" }>;
export type RecurringDefinition = Extract<
  WatchDefinition,
  { kind: "recurring" }
>;

export const checkResultSchema = Type.Object(
  {
    code: Type.Number(),
    killed: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type CheckResult = DeepReadonly<Static<typeof checkResultSchema>>;

export const watchFactsSchema = Type.Object(
  {
    attempts: Type.Number({ minimum: 0 }),
    deliveries: Type.Number({ minimum: 0 }),
    deliveryPending: Type.Boolean(),
    id: Type.String({ minLength: 1 }),
    lastCheckedAt: Type.Optional(Type.Number()),
    lastResult: Type.Optional(checkResultSchema),
    missedTicks: Type.Number({ minimum: 0 }),
    nextDueAt: Type.Number(),
    reloads: Type.Number({ minimum: 0 }),
    startedAt: Type.Number(),
  },
  { additionalProperties: false }
);

export type WatchFacts = DeepReadonly<Static<typeof watchFactsSchema>>;

export interface WatchActorInput {
  readonly definition: WatchDefinition;
  readonly facts: WatchFacts;
  readonly sessionIdle: boolean;
}

export type WatchContext = WatchActorInput;

export const gateOf = (definition: WatchDefinition): ShellGate | undefined =>
  definition.gate;

export const wakeOf = (definition: WatchDefinition): "agent" | "notify" =>
  definition.kind === "until" ? definition.wake : "agent";

export const expiresAtOf = (definition: WatchDefinition): number | undefined =>
  definition.expiresAt;

export const initialFacts = (
  definition: WatchDefinition,
  id: string,
  startedAt: number
): WatchFacts => ({
  attempts: 0,
  deliveries: 0,
  deliveryPending: false,
  id,
  missedTicks: 0,
  nextDueAt:
    definition.kind === "until" || definition.first === "now"
      ? startedAt
      : startedAt + definition.intervalMs,
  reloads: 0,
  startedAt,
});

const ticksDueThrough = (
  nextDueAt: number,
  intervalMs: number,
  now: number
): number =>
  nextDueAt > now ? 0 : Math.floor((now - nextDueAt) / intervalMs) + 1;

/** Consume the current recurring tick and coalesce any later ticks already due. */
export const advanceAfterTick = (
  facts: WatchFacts,
  intervalMs: number,
  now: number
): WatchFacts => {
  const next = facts.nextDueAt + intervalMs;
  const missed = ticksDueThrough(next, intervalMs, now);
  return {
    ...facts,
    missedTicks: facts.missedTicks + missed,
    nextDueAt: next + missed * intervalMs,
  };
};

/** Coalesce ticks that became due while a delivered follow-up was running. */
export const coalescePastDue = (
  facts: WatchFacts,
  intervalMs: number,
  now: number
): WatchFacts => {
  const missed = ticksDueThrough(facts.nextDueAt, intervalMs, now);
  return missed === 0
    ? facts
    : {
        ...facts,
        missedTicks: facts.missedTicks + missed,
        nextDueAt: facts.nextDueAt + missed * intervalMs,
      };
};
