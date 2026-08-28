import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { UntilInput } from "./machine.ts";

/**
 * Session entry written on `session_shutdown { reason: "reload" }` and read
 * back on `session_start { reason: "reload" }`. Pi keeps the process and the
 * session alive across `/reload`; only the extension closure is replaced. The
 * watch definitions are plain values, so they cross that boundary as data and
 * the runs are rebuilt on the other side.
 */
export const SUSPENDED_ENTRY_TYPE = "pi-until-suspended";

const suspendedWatchSchema = Type.Object({
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

const suspensionDataSchema = Type.Object({
  suspendedAt: Type.String(),
  watches: Type.Array(suspendedWatchSchema),
});

export type SuspendedWatch = Static<typeof suspendedWatchSchema>;
export type SuspensionData = Static<typeof suspensionDataSchema>;

export interface WatchHistory {
  /** Attempts made by earlier runs of the same watch before a reload. */
  readonly attempts: number;
  /** Number of reloads this watch has survived. */
  readonly reloads: number;
}

export const suspendWatch = (
  input: UntilInput,
  history: WatchHistory,
  attemptsThisRun: number
): SuspendedWatch => {
  const watch: SuspendedWatch = {
    attempts: history.attempts + attemptsThisRun,
    checkTimeoutMs: input.checkTimeoutMs,
    command: input.command,
    cwd: input.cwd,
    id: input.id,
    intervalMs: input.intervalMs,
    label: input.label,
    reloads: history.reloads + 1,
    startedAt: input.startedAt,
    wake: input.wake,
  };
  return input.timeoutMs === undefined
    ? watch
    : { ...watch, timeoutMs: input.timeoutMs };
};

export const suspensionData = (
  watches: readonly SuspendedWatch[],
  now: number
): SuspensionData => ({
  suspendedAt: new Date(now).toISOString(),
  watches: [...watches],
});

/**
 * The most recent suspension entry on the branch is the only one with
 * authority. Every reload writes one, even when it is empty, so an older
 * entry can never resurrect watches that already finished.
 */
export const suspendedWatchesFrom = (
  entries: readonly SessionEntry[]
): readonly SuspendedWatch[] => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SUSPENDED_ENTRY_TYPE) {
      continue;
    }
    return Value.Check(suspensionDataSchema, entry.data)
      ? entry.data.watches
      : [];
  }
  return [];
};

export const resumeInput = (watch: SuspendedWatch): UntilInput => {
  const input: UntilInput = {
    checkTimeoutMs: watch.checkTimeoutMs,
    command: watch.command,
    cwd: watch.cwd,
    id: watch.id,
    intervalMs: watch.intervalMs,
    label: watch.label,
    startedAt: watch.startedAt,
    wake: watch.wake,
  };
  return watch.timeoutMs === undefined
    ? input
    : { ...input, timeoutMs: watch.timeoutMs };
};

/** Remaining overall timeout measured from the original start, never reset. */
export const remainingTimeoutMs = (
  watch: Pick<SuspendedWatch, "startedAt" | "timeoutMs">,
  now: number
): number | undefined =>
  watch.timeoutMs === undefined
    ? undefined
    : Math.max(0, watch.startedAt + watch.timeoutMs - now);
