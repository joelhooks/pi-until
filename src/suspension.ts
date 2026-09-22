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
export const RESUMED_ENTRY_TYPE = "pi-until-resumed";
export const SUSPENSION_VERSION = 3;

/** The `session_shutdown` reasons that write a suspension entry. */
export type SuspensionReason = "reload" | "quit";

const persistedWatchSchema = Type.Object(
  {
    definition: watchDefinitionSchema,
    facts: watchFactsSchema,
  },
  { additionalProperties: false }
);

const suspensionDataSchema = Type.Object(
  {
    reason: Type.Union([Type.Literal("reload"), Type.Literal("quit")]),
    sessionId: Type.String(),
    suspendedAt: Type.String(),
    v: Type.Literal(SUSPENSION_VERSION),
    watches: Type.Array(persistedWatchSchema),
  },
  { additionalProperties: false }
);

/** Version 2 carried no reason or owner, so a quit and a reload look alike. */
const unattributedSuspensionDataSchema = Type.Object(
  {
    suspendedAt: Type.String(),
    v: Type.Literal(2),
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
  readonly reason: SuspensionReason;
  readonly sessionId: string;
  readonly suspendedAt: string;
  readonly v: typeof SUSPENSION_VERSION;
  readonly watches: readonly PersistedWatch[];
}

/** Marks a suspension entry as consumed by a process that started later. */
export interface ResumedData {
  readonly from: string;
  readonly resumed: number;
  readonly resumedAt: string;
  readonly skippedExpired: number;
}

/** The newest suspension entry on a branch, parsed at the boundary. */
export interface SuspensionRecord {
  readonly entryId: string;
  readonly index: number;
  /** Undefined for version 1 and 2 entries, which did not record it. */
  readonly reason?: SuspensionReason;
  readonly sessionId?: string;
  readonly timestamp: string;
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
  now: number,
  reason: SuspensionReason,
  sessionId: string
): SuspensionData => ({
  reason,
  sessionId,
  suspendedAt: new Date(now).toISOString(),
  v: SUSPENSION_VERSION,
  watches: [...watches],
});

export const resumedData = (
  from: string,
  resumed: number,
  skippedExpired: number,
  now: number
): ResumedData => ({
  from,
  resumed,
  resumedAt: new Date(now).toISOString(),
  skippedExpired,
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

const watchesFromData = (data: unknown): readonly PersistedWatch[] => {
  if (Value.Check(unattributedSuspensionDataSchema, data)) return data.watches;
  if (Value.Check(legacySuspensionDataSchema, data)) {
    const suspendedAt = Date.parse(data.suspendedAt);
    const normalizedAt = Number.isFinite(suspendedAt) ? suspendedAt : 0;
    return data.watches.map((watch) =>
      normalizeLegacyWatch(watch, normalizedAt)
    );
  }
  return [];
};

/**
 * The newest suspension entry on the branch is the only authority. Version 1
 * and 2 entries are normalized at this boundary; malformed newest entries
 * resolve to an empty set instead of reviving older facts.
 */
export const newestSuspension = (
  entries: readonly SessionEntry[]
): SuspensionRecord | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SUSPENDED_ENTRY_TYPE) {
      continue;
    }
    const base = { entryId: entry.id, index, timestamp: entry.timestamp };
    if (Value.Check(suspensionDataSchema, entry.data)) {
      return {
        ...base,
        reason: entry.data.reason,
        sessionId: entry.data.sessionId,
        watches: entry.data.watches,
      };
    }
    return { ...base, watches: watchesFromData(entry.data) };
  }
  return undefined;
};

export const suspendedWatchesFrom = (
  entries: readonly SessionEntry[]
): readonly PersistedWatch[] => newestSuspension(entries)?.watches ?? [];

/**
 * Watches in a suspension record that are still candidates for work: one per
 * id, and none that later wrote a finished receipt on the same branch.
 */
export const unfinishedWatches = (
  record: SuspensionRecord,
  entries: readonly SessionEntry[]
): readonly PersistedWatch[] => {
  const finished = new Set<string>();
  for (const entry of entries.slice(record.index + 1)) {
    if (entry.type !== "custom" || entry.customType !== "pi-until-finished") {
      continue;
    }
    const { data } = entry;
    if (typeof data === "object" && data !== null && "id" in data) {
      finished.add(String(data.id));
    }
  }
  const seen = new Set<string>();
  return record.watches.filter((watch) => {
    if (finished.has(watch.facts.id) || seen.has(watch.facts.id)) return false;
    seen.add(watch.facts.id);
    return true;
  });
};

export interface RestartOwner {
  /** The session header timestamp; entries older than it were copied by a fork. */
  readonly sessionCreatedAt?: string;
  readonly sessionId: string;
}

/**
 * Decide whether a process that just opened a session file owns the newest
 * suspension entry as unfinished quit work. Only a quit hands watches to the
 * next process. A reload entry was already resumed by its own process; if
 * that process died without a quit entry, the extension makes no claim.
 *
 * A version 3 entry must name this session, so a fork that copied it does
 * not run the parent's watches. A version 1 or 2 entry records neither the
 * reason nor the owner. It counts as a quit only when no conversation
 * message follows it and it is newer than this session's header.
 *
 * Any `pi-until-resumed` entry after it means a process already consumed it,
 * so a later crash cannot resurrect watches the operator since cancelled.
 */
export const quitSuspensionFor = (
  entries: readonly SessionEntry[],
  owner: RestartOwner
): SuspensionRecord | undefined => {
  const record = newestSuspension(entries);
  if (record === undefined || record.watches.length === 0) return undefined;
  const after = entries.slice(record.index + 1);
  if (
    after.some(
      (entry) =>
        entry.type === "custom" && entry.customType === RESUMED_ENTRY_TYPE
    )
  ) {
    return undefined;
  }
  if (record.reason === "quit") {
    return record.sessionId === owner.sessionId ? record : undefined;
  }
  if (record.reason === "reload") return undefined;
  if (after.some((entry) => entry.type === "message")) return undefined;
  const createdAt = Date.parse(owner.sessionCreatedAt ?? "");
  const writtenAt = Date.parse(record.timestamp);
  if (!Number.isFinite(createdAt) || !Number.isFinite(writtenAt)) {
    return undefined;
  }
  return writtenAt >= createdAt ? record : undefined;
};

export interface ResumePartition {
  /** Watches whose absolute expiry is still ahead of `now`. */
  readonly resumable: readonly PersistedWatch[];
  /** Watches whose absolute expiry has already passed. */
  readonly expired: readonly PersistedWatch[];
}

/**
 * Split suspended watches for a restart resume. A watch whose expiry passed
 * while no process owned it is history, not work.
 */
export const partitionResumable = (
  watches: readonly PersistedWatch[],
  now: number
): ResumePartition => {
  const resumable: PersistedWatch[] = [];
  const expired: PersistedWatch[] = [];
  for (const watch of watches) {
    const expiresAt = watch.definition.expiresAt;
    if (expiresAt !== undefined && expiresAt <= now) expired.push(watch);
    else resumable.push(watch);
  }
  return { expired, resumable };
};

export const resumeInput = (watch: PersistedWatch): WatchActorInput => ({
  definition: watch.definition,
  facts: watch.facts,
});
