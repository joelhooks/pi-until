import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { watchDefinitionSchema, watchFactsSchema } from "./domain.ts";
import type {
  WatchActorInput,
  WatchContext,
  WatchDefinition,
  WatchFacts,
} from "./domain.ts";

export const SUSPENDED_ENTRY_TYPE = "pi-until-suspended";
export const SUSPENSION_VERSION = 2;

const persistedWatchSchema = Type.Object(
  {
    definition: watchDefinitionSchema,
    facts: watchFactsSchema,
  },
  { additionalProperties: false }
);

const suspensionDataSchema = Type.Object(
  {
    suspendedAt: Type.String(),
    v: Type.Literal(SUSPENSION_VERSION),
    watches: Type.Array(persistedWatchSchema),
  },
  { additionalProperties: false }
);

const legacyWatchSchema = Type.Object({
  attempts: Type.Number(),
  checkTimeoutMs: Type.Number(),
  command: Type.String(),
  cwd: Type.String(),
  id: Type.String(),
  intervalMs: Type.Number(),
  label: Type.String(),
  reloads: Type.Number(),
  startedAt: Type.Number(),
  timeoutMs: Type.Optional(Type.Number()),
  wake: Type.Union([Type.Literal("agent"), Type.Literal("notify")]),
});

const legacySuspensionDataSchema = Type.Object({
  suspendedAt: Type.String(),
  watches: Type.Array(legacyWatchSchema),
});

export interface PersistedWatch {
  readonly definition: WatchDefinition;
  readonly facts: WatchFacts;
}

export interface SuspensionData {
  readonly suspendedAt: string;
  readonly v: typeof SUSPENSION_VERSION;
  readonly watches: readonly PersistedWatch[];
}

type LegacyWatch = Static<typeof legacyWatchSchema>;

export const suspendWatch = (context: WatchContext): PersistedWatch => ({
  definition: context.definition,
  facts: {
    ...context.facts,
    reloads: context.facts.reloads + 1,
  },
});

export const suspensionData = (
  watches: readonly PersistedWatch[],
  now: number
): SuspensionData => ({
  suspendedAt: new Date(now).toISOString(),
  v: SUSPENSION_VERSION,
  watches: [...watches],
});

const normalizeLegacyWatch = (
  watch: LegacyWatch,
  suspendedAt: number
): PersistedWatch => {
  const base: WatchDefinition = {
    gate: {
      checkTimeoutMs: watch.checkTimeoutMs,
      command: watch.command,
      cwd: watch.cwd,
    },
    intervalMs: watch.intervalMs,
    kind: "until",
    label: watch.label,
    wake: watch.wake,
  };
  const definition: WatchDefinition =
    watch.timeoutMs === undefined
      ? base
      : { ...base, expiresAt: watch.startedAt + watch.timeoutMs };
  const facts: WatchFacts = {
    attempts: watch.attempts,
    deliveries: 0,
    deliveryPending: false,
    id: watch.id,
    missedTicks: 0,
    nextDueAt: suspendedAt,
    reloads: watch.reloads,
    startedAt: watch.startedAt,
  };
  return { definition, facts };
};

/**
 * The newest suspension entry on the branch is the only authority. Version 1
 * entries are normalized at this boundary; malformed newest entries resolve
 * to an empty set instead of reviving older facts.
 */
export const suspendedWatchesFrom = (
  entries: readonly SessionEntry[]
): readonly PersistedWatch[] => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SUSPENDED_ENTRY_TYPE) {
      continue;
    }
    if (Value.Check(suspensionDataSchema, entry.data)) {
      return entry.data.watches;
    }
    if (Value.Check(legacySuspensionDataSchema, entry.data)) {
      const suspendedAt = Date.parse(entry.data.suspendedAt);
      const normalizedAt = Number.isFinite(suspendedAt) ? suspendedAt : 0;
      return entry.data.watches.map((watch) =>
        normalizeLegacyWatch(watch, normalizedAt)
      );
    }
    return [];
  }
  return [];
};

export const resumeInput = (watch: PersistedWatch): WatchActorInput => ({
  definition: watch.definition,
  facts: watch.facts,
});
