import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Local usage telemetry. One JSON object per line, appended to a file this
 * user owns. Nothing leaves the machine. The condition command is never
 * written; only a hash for grouping and the first word for "what kind of
 * thing do people wait on".
 */
export const TELEMETRY_VERSION = 1;
export const DEFAULT_TELEMETRY_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "pi-until",
  "events.jsonl"
);

const wakeSchema = Type.Union([Type.Literal("agent"), Type.Literal("notify")]);
const finalStatusSchema = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("timedOut"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);

const base = {
  at: Type.String(),
  sessionId: Type.String(),
  v: Type.Literal(TELEMETRY_VERSION),
};

const startedSchema = Type.Object({
  ...base,
  checkTimeoutMs: Type.Number(),
  conditionHash: Type.String(),
  conditionHead: Type.String(),
  event: Type.Literal("started"),
  id: Type.String(),
  intervalMs: Type.Number(),
  label: Type.String(),
  resumed: Type.Boolean(),
  timeoutMs: Type.Optional(Type.Number()),
  wake: wakeSchema,
});

const finishedSchema = Type.Object({
  ...base,
  attempts: Type.Number(),
  conditionHash: Type.String(),
  durationMs: Type.Number(),
  event: Type.Literal("finished"),
  id: Type.String(),
  lastCheckKilled: Type.Optional(Type.Boolean()),
  lastExitCode: Type.Optional(Type.Number()),
  reloads: Type.Number(),
  status: finalStatusSchema,
  wake: wakeSchema,
});

const suspendedSchema = Type.Object({
  ...base,
  count: Type.Number(),
  event: Type.Literal("suspended"),
});

const resumedSchema = Type.Object({
  ...base,
  count: Type.Number(),
  event: Type.Literal("resumed"),
});

const actionSchema = Type.Object({
  ...base,
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("list"),
    Type.Literal("status"),
    Type.Literal("cancel"),
    Type.Literal("stats"),
  ]),
  event: Type.Literal("action"),
  source: Type.Union([Type.Literal("tool"), Type.Literal("command")]),
});

const telemetryEventSchema = Type.Union([
  startedSchema,
  finishedSchema,
  suspendedSchema,
  resumedSchema,
  actionSchema,
]);

export type TelemetryEvent = Static<typeof telemetryEventSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** What callers supply; the sink stamps `at`, `sessionId`, and `v`. */
export type TelemetryEventInput = DistributiveOmit<
  TelemetryEvent,
  "at" | "sessionId" | "v"
>;

export interface ConditionDescription {
  readonly hash: string;
  readonly head: string;
}

/** Group by hash, describe by first word. The command itself stays private. */
export const describeCondition = (command: string): ConditionDescription => {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/u, 1)[0] ?? "";
  const head = firstWord.startsWith("-") ? "" : basename(firstWord);
  return {
    hash: createHash("sha256").update(trimmed).digest("hex").slice(0, 12),
    head: head || "(empty)",
  };
};

export interface TelemetrySink {
  readonly enabled: boolean;
  readonly filePath: string;
  readonly record: (
    sessionId: string,
    event: TelemetryEventInput
  ) => Promise<void>;
}

export interface TelemetrySinkOptions {
  readonly enabled?: boolean;
  readonly filePath?: string;
  readonly now?: () => number;
}

export const telemetryOptionsFromEnv = (
  env: NodeJS.ProcessEnv
): TelemetrySinkOptions => ({
  enabled: env.PI_UNTIL_TELEMETRY !== "0",
  filePath: env.PI_UNTIL_TELEMETRY_FILE?.trim() || DEFAULT_TELEMETRY_FILE,
});

export const createTelemetrySink = (
  options: TelemetrySinkOptions = {}
): TelemetrySink => {
  const enabled = options.enabled ?? true;
  const filePath = options.filePath ?? DEFAULT_TELEMETRY_FILE;
  const now = options.now ?? Date.now;
  let directoryReady: Promise<string | undefined> | undefined;

  const record: TelemetrySink["record"] = async (sessionId, event) => {
    if (!enabled) {
      return;
    }
    const full: TelemetryEvent = {
      ...event,
      at: new Date(now()).toISOString(),
      sessionId,
      v: TELEMETRY_VERSION,
    };
    try {
      directoryReady ??= mkdir(dirname(filePath), { recursive: true });
      await directoryReady;
      await appendFile(filePath, `${JSON.stringify(full)}\n`, "utf-8");
    } catch {
      // Telemetry must never break a watch.
    }
  };

  return { enabled, filePath, record };
};

export const parseTelemetryLines = (text: string): TelemetryEvent[] => {
  const events: TelemetryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Value.Check(telemetryEventSchema, parsed)) {
      events.push(parsed);
    }
  }
  return events;
};

export const readTelemetry = async (
  filePath: string
): Promise<TelemetryEvent[]> => {
  try {
    return parseTelemetryLines(await readFile(filePath, "utf-8"));
  } catch {
    return [];
  }
};

export interface TelemetrySummary {
  readonly actions: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byWake: Readonly<Record<string, number>>;
  readonly finished: number;
  readonly medianAttempts: number | undefined;
  readonly medianDurationMs: number | undefined;
  readonly resumedWatches: number;
  readonly sessions: number;
  readonly started: number;
  readonly suspendedWatches: number;
  readonly topHeads: readonly {
    readonly count: number;
    readonly head: string;
  }[];
}

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  const lower = sorted[middle - 1] ?? upper;
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
};

const count = (tally: Record<string, number>, key: string, by = 1): void => {
  tally[key] = (tally[key] ?? 0) + by;
};

export const summarizeTelemetry = (
  events: readonly TelemetryEvent[]
): TelemetrySummary => {
  const actions: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byWake: Record<string, number> = {};
  const heads: Record<string, number> = {};
  const sessions = new Set<string>();
  const attempts: number[] = [];
  const durations: number[] = [];
  let started = 0;
  let finished = 0;
  let suspendedWatches = 0;
  let resumedWatches = 0;

  for (const event of events) {
    sessions.add(event.sessionId);
    switch (event.event) {
      case "started": {
        if (!event.resumed) {
          started += 1;
          count(byWake, event.wake);
          count(heads, event.conditionHead);
        }
        break;
      }
      case "finished": {
        finished += 1;
        count(byStatus, event.status);
        attempts.push(event.attempts);
        durations.push(event.durationMs);
        break;
      }
      case "suspended": {
        suspendedWatches += event.count;
        break;
      }
      case "resumed": {
        resumedWatches += event.count;
        break;
      }
      case "action": {
        count(actions, `${event.source}:${event.action}`);
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled telemetry event ${String(exhaustive)}`);
      }
    }
  }

  const topHeads = Object.entries(heads)
    .map(([head, headCount]) => ({ count: headCount, head }))
    .sort(
      (left, right) =>
        right.count - left.count || left.head.localeCompare(right.head)
    )
    .slice(0, 8);

  return {
    actions,
    byStatus,
    byWake,
    finished,
    medianAttempts: median(attempts),
    medianDurationMs: median(durations),
    resumedWatches,
    sessions: sessions.size,
    started,
    suspendedWatches,
    topHeads,
  };
};

const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

const formatTally = (tally: Readonly<Record<string, number>>): string =>
  Object.entries(tally)
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ") || "none";

export const summaryText = (
  summary: TelemetrySummary,
  filePath: string
): string =>
  [
    `pi-until stats (${filePath})`,
    `Sessions: ${summary.sessions}`,
    `Watches started: ${summary.started}  finished: ${summary.finished}`,
    `By status: ${formatTally(summary.byStatus)}`,
    `By wake: ${formatTally(summary.byWake)}`,
    `Median attempts: ${summary.medianAttempts ?? "n/a"}  median duration: ${formatDuration(summary.medianDurationMs)}`,
    `Reload suspended: ${summary.suspendedWatches}  resumed: ${summary.resumedWatches}`,
    `Top conditions: ${summary.topHeads.map((item) => `${item.head}=${item.count}`).join(" ") || "none"}`,
    `Actions: ${formatTally(summary.actions)}`,
  ].join("\n");
