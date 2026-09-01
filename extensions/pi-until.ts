import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { createActor } from "xstate";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import { createShellConditionRunner } from "../src/check.ts";
import { planCompletion } from "../src/completion.ts";
import {
  contextRefSchema,
  gateOf,
  initialFacts,
  wakeOf,
} from "../src/domain.ts";
import type {
  ContextRef,
  FollowUpSnapshot,
  ShellGate,
  WatchActorInput,
  WatchDefinition,
} from "../src/domain.ts";
import { renderWatchIndicator, renderWatchPanel } from "../src/indicator.ts";
import type { WatchDisplay, WatchPhase } from "../src/indicator.ts";
import { createWatchMachine } from "../src/machine.ts";
import type { WatchTerminalState } from "../src/machine.ts";
import {
  renderRecurringExpiredPacket,
  renderRecurringWakePacket,
} from "../src/packet.ts";
import {
  SUSPENDED_ENTRY_TYPE,
  resumeInput,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
} from "../src/suspension.ts";
import type { PersistedWatch } from "../src/suspension.ts";
import {
  createTelemetrySink,
  describeCondition,
  readTelemetry,
  summarizeTelemetry,
  summaryText,
  telemetryOptionsFromEnv,
} from "../src/telemetry.ts";
import type { TelemetrySink } from "../src/telemetry.ts";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 30;
const MAX_ACTIVE_WATCHES = 32;
const WIDGET_KEY = "pi-until-watches";
const PANEL_PAGE_SIZE = 6;
const INDICATOR_REFRESH_MS = 250;

export const untilParameters = Type.Object(
  {
    action: StringEnum([
      "start",
      "repeat",
      "list",
      "status",
      "complete",
      "cancel",
    ] as const),
    checkTimeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 3_600,
        description: "Maximum runtime for one gate check. Defaults to 30.",
      })
    ),
    condition: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Side-effect-free shell condition or recurring gate. Exit code 0 means true.",
      })
    ),
    contextRefs: Type.Optional(Type.Array(contextRefSchema, { maxItems: 16 })),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory for the shell gate. Defaults to Pi's current directory.",
      })
    ),
    id: Type.Optional(Type.String({ minLength: 1, description: "Watch ID." })),
    immediate: Type.Optional(
      Type.Boolean({
        description: "For repeat: wake after this turn before fixed cadence.",
      })
    ),
    instruction: Type.Optional(
      Type.String({ minLength: 1, maxLength: 20_000 })
    ),
    intervalSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 86_400,
        description:
          "Seconds between checks or recurring follow-ups. Defaults to 30.",
      })
    ),
    label: Type.Optional(
      Type.String({ description: "Short safe label. Do not include secrets." })
    ),
    quickRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    timeoutSeconds: Type.Optional(
      Type.Number({ minimum: 1, maximum: 2_000_000 })
    ),
    wake: Type.Optional(StringEnum(["agent", "notify"] as const)),
  },
  { additionalProperties: false }
);

type UntilParameters = Static<typeof untilParameters>;

const bridgeArgumentsSchema = Type.Object(
  {
    checkTimeoutSeconds: Type.Optional(
      Type.Union([Type.Number(), Type.String()])
    ),
    contextRefs: Type.Optional(
      Type.Union([Type.Array(contextRefSchema), Type.String()])
    ),
    immediate: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
    intervalSeconds: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    timeoutSeconds: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  },
  { additionalProperties: true }
);

const stringSchema = Type.String();

const coerceFiniteNumber = (
  value: number | string | undefined
): number | string | undefined => {
  if (!Value.Check(stringSchema, value) || value.trim() === "") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
};

type PrepareUntilArguments = NonNullable<
  ToolDefinition<typeof untilParameters>["prepareArguments"]
>;

/** Repair known provider bridges that serialize every non-string argument as JSON text. */
export const prepareUntilArguments: PrepareUntilArguments = (input) => {
  if (!Value.Check(bridgeArgumentsSchema, input)) {
    // SAFETY: Pi validates this return value against untilParameters immediately.
    return input as UntilParameters;
  }

  const prepared = { ...input };
  prepared.checkTimeoutSeconds = coerceFiniteNumber(
    prepared.checkTimeoutSeconds
  );
  prepared.intervalSeconds = coerceFiniteNumber(prepared.intervalSeconds);
  prepared.timeoutSeconds = coerceFiniteNumber(prepared.timeoutSeconds);
  if (prepared.immediate === "true") prepared.immediate = true;
  if (prepared.immediate === "false") prepared.immediate = false;
  if (Value.Check(stringSchema, prepared.contextRefs)) {
    try {
      const parsed: unknown = JSON.parse(prepared.contextRefs);
      if (Value.Check(Type.Array(contextRefSchema), parsed)) {
        prepared.contextRefs = parsed;
      }
    } catch {
      // Leave malformed JSON intact so normal schema validation reports it.
    }
  }

  // SAFETY: Pi validates required fields and action-specific rules after this shim.
  return prepared as UntilParameters;
};
type ReceiptStatus =
  | "running"
  | "succeeded"
  | "timedOut"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";
type FinalReceiptStatus = Exclude<ReceiptStatus, "running">;
type WatchMachine = ReturnType<typeof createWatchMachine>;
type WatchActor = ActorRefFrom<WatchMachine>;
type WatchSnapshot = SnapshotFrom<WatchMachine>;

interface WatchRecord {
  readonly actor: WatchActor;
  defect?: string;
  dispatchedDeliveries: number;
  finishedAt?: number;
}

export interface PiUntilOptions {
  readonly telemetry?: TelemetrySink;
}

export interface WatchReceipt {
  readonly attempts: number;
  readonly contextRefs?: readonly ContextRef[];
  readonly defect?: string;
  readonly deliveries: number;
  readonly deliveryPending: boolean;
  readonly expiresAt?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly kind: WatchDefinition["kind"];
  readonly label: string;
  readonly lastCheckKilled?: boolean;
  readonly lastCheckedAt?: string;
  readonly lastExitCode?: number;
  readonly missedTicks: number;
  readonly nextDueAt?: string;
  readonly quickRef?: string;
  readonly reloads: number;
  readonly startedAt: string;
  readonly status: ReceiptStatus;
  readonly wake: "agent" | "notify";
}

const sessionId = (ctx: ExtensionContext | undefined) =>
  ctx?.sessionManager.getSessionId() ?? "unknown";

function expandPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function terminalState(
  snapshot: WatchSnapshot
): WatchTerminalState | undefined {
  if (snapshot.status !== "done") return undefined;
  if (snapshot.matches("satisfied")) return "satisfied";
  if (snapshot.matches("completed")) return "completed";
  if (snapshot.matches("expired")) return "expired";
  if (snapshot.matches("cancelled")) return "cancelled";
  return undefined;
}

function receiptStatus(record: WatchRecord): ReceiptStatus {
  if (record.defect !== undefined) return "failed";
  const snapshot = record.actor.getSnapshot();
  const terminal = terminalState(snapshot);
  if (terminal === undefined) return "running";
  if (terminal === "satisfied") return "succeeded";
  if (terminal === "expired") {
    return snapshot.context.definition.kind === "until"
      ? "timedOut"
      : "expired";
  }
  return terminal;
}

function finalReceiptStatus(record: WatchRecord): FinalReceiptStatus {
  const status = receiptStatus(record);
  if (status === "running") {
    throw new Error("cannot finish a running pi-until watch");
  }
  return status;
}

function toReceipt(record: WatchRecord): WatchReceipt {
  const { definition, facts } = record.actor.getSnapshot().context;
  const status = receiptStatus(record);
  const recurring = definition.kind === "recurring" ? definition : undefined;
  return {
    attempts: facts.attempts,
    contextRefs: recurring?.snapshot.contextRefs,
    defect: record.defect,
    deliveries: facts.deliveries,
    deliveryPending: facts.deliveryPending,
    expiresAt:
      definition.expiresAt === undefined
        ? undefined
        : new Date(definition.expiresAt).toISOString(),
    finishedAt:
      record.finishedAt === undefined
        ? undefined
        : new Date(record.finishedAt).toISOString(),
    id: facts.id,
    kind: definition.kind,
    label: definition.label,
    lastCheckedAt:
      facts.lastCheckedAt === undefined
        ? undefined
        : new Date(facts.lastCheckedAt).toISOString(),
    lastCheckKilled: facts.lastResult?.killed,
    lastExitCode: facts.lastResult?.code,
    missedTicks: facts.missedTicks,
    nextDueAt:
      status === "running"
        ? new Date(facts.nextDueAt).toISOString()
        : undefined,
    quickRef: recurring?.snapshot.quickRef,
    reloads: facts.reloads,
    startedAt: new Date(facts.startedAt).toISOString(),
    status,
    wake: wakeOf(definition),
  };
}

function watchPhase(record: WatchRecord): WatchPhase | undefined {
  if (receiptStatus(record) !== "running") return undefined;
  const snapshot = record.actor.getSnapshot();
  if (snapshot.matches({ active: "checking" })) return "checking";
  if (snapshot.matches({ active: "duePending" })) return "duePending";
  if (snapshot.matches({ active: "awaitingSettlement" })) {
    return "awaitingSettlement";
  }
  return "sleeping";
}

function receiptText(receipt: WatchReceipt): string {
  const lines = [
    `pi-until watch ${receipt.id}: ${receipt.status}`,
    `Kind: ${receipt.kind}`,
    `Label: ${receipt.label}`,
    `Checks: ${receipt.attempts}`,
  ];
  if (receipt.kind === "recurring") {
    lines.push(
      `Deliveries: ${receipt.deliveries}`,
      `Delivery pending: ${receipt.deliveryPending ? "yes" : "no"}`,
      `Missed ticks: ${receipt.missedTicks}`
    );
    if (receipt.quickRef !== undefined)
      lines.push(`Quick ref: ${receipt.quickRef}`);
    if (receipt.nextDueAt !== undefined)
      lines.push(`Next due: ${receipt.nextDueAt}`);
    if (receipt.expiresAt !== undefined)
      lines.push(`Expires: ${receipt.expiresAt}`);
  }
  if (receipt.reloads > 0) lines.push(`Survived reloads: ${receipt.reloads}`);
  if (receipt.lastExitCode !== undefined) {
    lines.push(`Last exit code: ${receipt.lastExitCode}`);
  }
  if (receipt.lastCheckKilled === true)
    lines.push("Last check was terminated.");
  if (receipt.defect !== undefined) lines.push(`Failure: ${receipt.defect}`);
  return lines.join("\n");
}

export default function piUntil(
  pi: ExtensionAPI,
  options: PiUntilOptions = {}
) {
  const watches = new Map<string, WatchRecord>();
  let currentContext: ExtensionContext | undefined;
  let indicatorMounted = false;
  let requestIndicatorRender: (() => void) | undefined;
  let shuttingDown = false;

  const shellRunner = createShellConditionRunner();
  const machine = createWatchMachine(shellRunner.run);
  const telemetry =
    options.telemetry ??
    createTelemetrySink(telemetryOptionsFromEnv(process.env));

  const track = telemetry.record;

  const activeWatches = () =>
    [...watches.values()].filter((watch) => receiptStatus(watch) === "running");

  const toWatchDisplay = (record: WatchRecord): WatchDisplay => {
    const { definition, facts } = record.actor.getSnapshot().context;
    return {
      attempts: facts.attempts,
      deliveries: facts.deliveries,
      id: facts.id,
      intervalMs: definition.intervalMs,
      kind: definition.kind,
      label: definition.label,
      missedTicks: facts.missedTicks,
      nextDueAt: facts.nextDueAt,
      phase: watchPhase(record),
      startedAt: facts.startedAt,
      status: receiptStatus(record),
      wake: wakeOf(definition),
    };
  };

  const orderedWatches = () =>
    [...watches.values()].sort((left, right) => {
      const leftReceipt = toReceipt(left);
      const rightReceipt = toReceipt(right);
      const runningDifference =
        Number(rightReceipt.status === "running") -
        Number(leftReceipt.status === "running");
      return (
        runningDifference ||
        Date.parse(rightReceipt.startedAt) - Date.parse(leftReceipt.startedAt)
      );
    });

  const refreshIndicator = () => {
    const ctx = currentContext;
    if (ctx?.mode !== "tui") return;

    if (activeWatches().length === 0) {
      if (indicatorMounted) ctx.ui.setWidget(WIDGET_KEY, undefined);
      indicatorMounted = false;
      requestIndicatorRender = undefined;
      return;
    }

    if (!indicatorMounted) {
      indicatorMounted = true;
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const requestRender = () => tui.requestRender();
        requestIndicatorRender = requestRender;
        const refreshTimer = setInterval(requestRender, INDICATOR_REFRESH_MS);
        refreshTimer.unref();
        return {
          dispose() {
            clearInterval(refreshTimer);
            if (requestIndicatorRender === requestRender) {
              requestIndicatorRender = undefined;
            }
          },
          invalidate() {
            // Render reads live watch state and theme values.
          },
          render(width: number) {
            return renderWatchIndicator(
              activeWatches().map(toWatchDisplay),
              Date.now(),
              width,
              theme
            );
          },
        };
      });
      return;
    }

    requestIndicatorRender?.();
  };

  const finishWatch = (record: WatchRecord) => {
    if (record.finishedAt !== undefined) return;
    record.finishedAt = Date.now();
    refreshIndicator();
    if (shuttingDown) return;

    const receipt = toReceipt(record);
    const { definition, facts } = record.actor.getSnapshot().context;
    const condition = describeCondition(gateOf(definition)?.command ?? "");
    void track(sessionId(currentContext), {
      attempts: receipt.attempts,
      conditionHash: condition.hash,
      deliveries: receipt.deliveries,
      durationMs: record.finishedAt - facts.startedAt,
      event: "finished",
      id: receipt.id,
      lastCheckKilled: receipt.lastCheckKilled,
      lastExitCode: receipt.lastExitCode,
      missedTicks: receipt.missedTicks,
      reloads: receipt.reloads,
      status: finalReceiptStatus(record),
      wake: receipt.wake,
      watchKind: receipt.kind,
    });
    if (receipt.status === "cancelled") return;
    pi.appendEntry("pi-until-finished", receipt);

    if (definition.kind === "recurring") {
      if (receipt.status === "expired") {
        pi.sendMessage(
          {
            content: renderRecurringExpiredPacket(definition.snapshot, {
              delivery: facts.deliveries,
              expiresAt: definition.expiresAt,
              id: facts.id,
              missedTicks: facts.missedTicks,
              reloads: facts.reloads,
            }),
            customType: "pi-until-recurring",
            details: receipt,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
      } else if (receipt.status === "failed") {
        pi.sendMessage(
          {
            content: `The recurring watch failed. Inspect this receipt before deciding what to do.\n\n${receiptText(receipt)}`,
            customType: "pi-until-recurring",
            details: receipt,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
      }
      return;
    }

    if (
      receipt.status !== "succeeded" &&
      receipt.status !== "timedOut" &&
      receipt.status !== "failed"
    ) {
      return;
    }
    const plan = planCompletion(receipt.status, receipt.wake);
    if (plan.kind === "agent") {
      pi.sendMessage(
        {
          content: `${plan.instruction}\n\n${receiptText(receipt)}`,
          customType: "pi-until",
          details: receipt,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true }
      );
    } else {
      currentContext?.ui.notify(
        `${definition.label}: ${plan.summary}`,
        plan.level
      );
    }
  };

  const deliverRecurringFollowUp = (record: WatchRecord) => {
    if (shuttingDown) return;
    const { definition, facts } = record.actor.getSnapshot().context;
    if (
      definition.kind !== "recurring" ||
      facts.deliveries <= record.dispatchedDeliveries
    ) {
      return;
    }
    record.dispatchedDeliveries = facts.deliveries;
    const deliveredAt = Date.now();
    const receipt = toReceipt(record);
    pi.sendMessage(
      {
        content: renderRecurringWakePacket(definition.snapshot, {
          deliveredAt,
          delivery: facts.deliveries,
          expiresAt: definition.expiresAt,
          id: facts.id,
          missedTicks: facts.missedTicks,
          nextDueAt: facts.nextDueAt,
          reloads: facts.reloads,
        }),
        customType: "pi-until-recurring",
        details: receipt,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true }
    );
  };

  const gateFrom = (
    params: UntilParameters,
    ctx: ExtensionContext
  ): ShellGate => {
    const command = params.condition?.trim();
    if (!command) throw new Error("condition is required for action=start");
    const cwd = resolve(ctx.cwd, expandPath(params.cwd ?? "."));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
    return {
      checkTimeoutMs:
        (params.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS) * 1_000,
      command,
      cwd,
    };
  };

  const untilDefinitionFrom = (
    params: UntilParameters,
    ctx: ExtensionContext,
    startedAt: number,
    intervalMs: number
  ): WatchDefinition => {
    const base = {
      gate: gateFrom(params, ctx),
      intervalMs,
      kind: "until" as const,
      label: params.label?.trim() || "condition",
      wake: params.wake ?? "agent",
    };
    return params.timeoutSeconds === undefined
      ? base
      : { ...base, expiresAt: startedAt + params.timeoutSeconds * 1_000 };
  };

  const recurringDefinitionFrom = (
    params: UntilParameters,
    ctx: ExtensionContext,
    startedAt: number,
    intervalMs: number
  ): WatchDefinition => {
    const { instruction, quickRef } = params;
    if (!instruction?.trim())
      throw new Error("instruction is required for action=repeat");
    if (!quickRef?.trim())
      throw new Error("quickRef is required for action=repeat");
    if (params.timeoutSeconds === undefined) {
      throw new Error("timeoutSeconds is required for action=repeat");
    }
    if (params.wake === "notify") {
      throw new Error(
        "repeat always wakes the agent; wake=notify is not supported"
      );
    }
    const contextRefs = Object.freeze(
      (params.contextRefs ?? []).map((reference) =>
        Object.freeze({
          label: reference.label,
          target: reference.target,
        })
      )
    );
    if (
      contextRefs.some(
        (reference) => !reference.label.trim() || !reference.target.trim()
      )
    ) {
      throw new Error("contextRefs require non-empty label and target values");
    }
    const entryId = ctx.sessionManager.getLeafId() ?? undefined;
    const origin = Object.freeze(
      entryId === undefined
        ? { sessionId: sessionId(ctx) }
        : { entryId, sessionId: sessionId(ctx) }
    );
    const snapshot: FollowUpSnapshot = Object.freeze({
      capturedAt: startedAt,
      contextRefs,
      instruction,
      origin,
      quickRef,
    });
    const condition = params.condition?.trim();
    return {
      expiresAt: startedAt + params.timeoutSeconds * 1_000,
      first: params.immediate === true ? "now" : "afterInterval",
      gate: condition ? gateFrom(params, ctx) : undefined,
      intervalMs,
      kind: "recurring",
      label: params.label?.trim() || "recurring follow-up",
      snapshot,
    };
  };

  const definitionFrom = (
    params: UntilParameters,
    ctx: ExtensionContext,
    startedAt: number
  ): WatchDefinition => {
    const intervalMs =
      (params.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000;
    if (params.action === "start") {
      return untilDefinitionFrom(params, ctx, startedAt, intervalMs);
    }
    if (params.action === "repeat") {
      return recurringDefinitionFrom(params, ctx, startedAt, intervalMs);
    }
    throw new Error("cannot start a watch with this action");
  };

  const startWatch = (
    params: UntilParameters,
    ctx: ExtensionContext
  ): WatchRecord => {
    if (ctx.mode === "print" || ctx.mode === "json") {
      throw new Error(
        "pi-until requires a long-lived interactive or RPC Pi process"
      );
    }
    if (activeWatches().length >= MAX_ACTIVE_WATCHES) {
      throw new Error(
        `pi-until allows at most ${MAX_ACTIVE_WATCHES} active watches`
      );
    }

    const id = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    const definition = definitionFrom(params, ctx, startedAt);
    const input: WatchActorInput = {
      definition,
      facts: initialFacts(definition, id, startedAt),
      sessionIdle: ctx.isIdle(),
    };
    const record = runWatch(input);
    const receipt = toReceipt(record);
    pi.appendEntry("pi-until-started", {
      receipt,
      snapshot:
        definition.kind === "recurring" ? definition.snapshot : undefined,
    });
    const gate = gateOf(definition);
    const condition = describeCondition(gate?.command ?? "");
    void track(sessionId(ctx), {
      checkTimeoutMs:
        gate?.checkTimeoutMs ??
        (params.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS) * 1_000,
      conditionHash: condition.hash,
      conditionHead: condition.head,
      event: "started",
      id,
      intervalMs: definition.intervalMs,
      label: definition.label,
      resumed: false,
      timeoutMs:
        definition.expiresAt === undefined
          ? undefined
          : definition.expiresAt - startedAt,
      wake: wakeOf(definition),
      watchKind: definition.kind,
    });
    return record;
  };

  /** Resume watches suspended by the previous extension instance on `/reload`. */
  const resumeWatches = (
    suspended: readonly PersistedWatch[],
    ctx: ExtensionContext
  ) => {
    for (const watch of suspended) {
      if (watches.has(watch.facts.id)) continue;
      const input = resumeInput(watch, ctx.isIdle());
      runWatch(input);
      const gate = gateOf(input.definition);
      const condition = describeCondition(gate?.command ?? "");
      void track(sessionId(ctx), {
        checkTimeoutMs:
          gate?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_SECONDS * 1_000,
        conditionHash: condition.hash,
        conditionHead: condition.head,
        event: "started",
        id: input.facts.id,
        intervalMs: input.definition.intervalMs,
        label: input.definition.label,
        resumed: true,
        timeoutMs:
          input.definition.expiresAt === undefined
            ? undefined
            : input.definition.expiresAt - input.facts.startedAt,
        wake: wakeOf(input.definition),
        watchKind: input.definition.kind,
      });
    }
    if (suspended.length > 0) {
      void track(sessionId(ctx), { count: suspended.length, event: "resumed" });
      ctx.ui.notify(
        `pi-until resumed ${suspended.length} watch${suspended.length === 1 ? "" : "es"} after reload`,
        "info"
      );
    }
  };

  /** Start one authoritative actor from a fresh or restored watch value. */
  const runWatch = (input: WatchActorInput): WatchRecord => {
    const actor = createActor(machine, { input });
    const record: WatchRecord = {
      actor,
      dispatchedDeliveries: input.facts.deliveries,
    };
    watches.set(input.facts.id, record);

    actor.subscribe({
      error(error) {
        if (record.finishedAt !== undefined) return;
        record.defect = error instanceof Error ? error.message : String(error);
        finishWatch(record);
      },
      next(snapshot) {
        if (
          snapshot.matches({ active: "awaitingSettlement" }) &&
          snapshot.context.facts.deliveries > record.dispatchedDeliveries
        ) {
          deliverRecurringFollowUp(record);
        }
        if (terminalState(snapshot) !== undefined) {
          finishWatch(record);
          return;
        }
        refreshIndicator();
      },
    });

    actor.start();
    refreshIndicator();
    return record;
  };

  const listText = (records: WatchRecord[]) => {
    if (records.length === 0) {
      return "No pi-until watches.";
    }
    return records
      .map((record) => {
        const receipt = toReceipt(record);
        return `${receipt.id}\t${receipt.status}\t${receipt.label}\tattempts=${receipt.attempts}`;
      })
      .join("\n");
  };

  const showWatchPanel = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(listText(orderedWatches()), "info");
      return;
    }

    let offset = 0;
    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) => {
        const upKeys = keybindings.getKeys("tui.select.up").join("/");
        const downKeys = keybindings.getKeys("tui.select.down").join("/");
        const closeKeys = keybindings.getKeys("tui.select.cancel").join("/");
        const navigationHint = `${upKeys}/${downKeys} scroll · ${closeKeys} close`;
        const requestRender = () => tui.requestRender();
        const refreshTimer = setInterval(requestRender, 1_000);
        refreshTimer.unref();
        return {
          dispose() {
            clearInterval(refreshTimer);
          },
          handleInput(data: string) {
            const count = orderedWatches().length;
            const maximumOffset = Math.max(0, count - 1);
            if (keybindings.matches(data, "tui.select.up")) {
              offset = Math.max(0, offset - 1);
            } else if (keybindings.matches(data, "tui.select.down")) {
              offset = Math.min(maximumOffset, offset + 1);
            } else if (keybindings.matches(data, "tui.select.pageUp")) {
              offset = Math.max(0, offset - PANEL_PAGE_SIZE);
            } else if (keybindings.matches(data, "tui.select.pageDown")) {
              offset = Math.min(maximumOffset, offset + PANEL_PAGE_SIZE);
            } else if (
              keybindings.matches(data, "tui.select.cancel") ||
              keybindings.matches(data, "tui.select.confirm")
            ) {
              done(null);
              return;
            }
            requestRender();
          },
          invalidate() {
            // Render reads live watch state and theme values.
          },
          render(width: number) {
            return renderWatchPanel(
              orderedWatches().map(toWatchDisplay),
              Date.now(),
              width,
              offset,
              PANEL_PAGE_SIZE,
              navigationHint,
              theme
            );
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          margin: 1,
          maxHeight: "85%",
          minWidth: 56,
          width: "72%",
        },
      }
    );
  };

  pi.registerTool({
    description:
      "Start one-shot shell-condition watches or recurring Markdown follow-ups. Recurrences use fixed cadence, optional side-effect-free gates, immutable task snapshots, explicit completion, and session-scoped /reload survival.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: params.action,
        event: "action",
        source: "tool",
      });
      if (params.action === "start" || params.action === "repeat") {
        const record = startWatch(params, ctx);
        const receipt = toReceipt(record);
        const { definition } = record.actor.getSnapshot().context;
        const timing =
          definition.kind === "until"
            ? `It will check immediately, then every ${definition.intervalMs / 1_000}s.`
            : `Its first wake is ${definition.first === "now" ? "after this turn" : receipt.nextDueAt}, then every ${definition.intervalMs / 1_000}s until ${receipt.expiresAt}.`;
        return {
          content: [
            {
              type: "text",
              text: `Started pi-until ${receipt.kind} watch ${receipt.id} (${receipt.label}). ${timing}`,
            },
          ],
          details: receipt,
        };
      }

      if (params.action === "list") {
        const records = [...watches.values()];
        return {
          content: [{ type: "text", text: listText(records) }],
          details: { watches: records.map(toReceipt) },
        };
      }

      if (!params.id)
        throw new Error(`id is required for action=${params.action}`);
      const record = watches.get(params.id);
      if (!record) throw new Error(`unknown pi-until watch: ${params.id}`);

      if (params.action === "complete") {
        const { definition } = record.actor.getSnapshot().context;
        if (definition.kind !== "recurring") {
          throw new Error("only recurring watches can be completed explicitly");
        }
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "COMPLETE" });
        }
        const receipt = toReceipt(record);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      if (params.action === "cancel") {
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "CANCEL" });
        }
        const receipt = toReceipt(record);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      const receipt = toReceipt(record);
      return {
        content: [{ type: "text", text: receiptText(receipt) }],
        details: receipt,
      };
    },
    label: "Until",
    name: "until",
    parameters: untilParameters,
    prepareArguments: prepareUntilArguments,
    promptGuidelines: [
      "Use until with action=start when work should resume after a side-effect-free shell condition exits 0; do not block bash with polling or sleep loops.",
      "Use until with action=repeat for session-scoped recurring agent follow-ups. Supply timeoutSeconds, instruction, and quickRef; contextRefs are opaque pointers expanded by the waking agent.",
      "Keep until recurring snapshots short and secret-free. The instruction, quickRef, and contextRefs are immutable and persist in the private Pi session.",
      "Use until action=complete when a recurring goal is achieved, or action=cancel when it should stop without success.",
    ],
    promptSnippet:
      "Start, inspect, complete, or cancel condition watches and recurring follow-ups",
  });

  pi.registerCommand("until", {
    description:
      "Start a default agent-waking watch: /until <side-effect-free shell condition>",
    handler: async (args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "start",
        event: "action",
        source: "command",
      });
      if (!args.trim()) {
        ctx.ui.notify(
          "Usage: /until <side-effect-free shell condition>",
          "warning"
        );
        return;
      }
      try {
        const record = startWatch({ action: "start", condition: args }, ctx);
        const receipt = toReceipt(record);
        ctx.ui.notify(`Watching ${receipt.label} as ${receipt.id}`, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      }
    },
  });

  pi.registerCommand("until-list", {
    description: "Open watches owned by this Pi session",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "list",
        event: "action",
        source: "command",
      });
      await showWatchPanel(ctx);
    },
  });

  pi.registerCommand("until-stats", {
    description: "Summarize local pi-until usage telemetry",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "stats",
        event: "action",
        source: "command",
      });
      if (!telemetry.enabled) {
        ctx.ui.notify(
          "pi-until telemetry is disabled (PI_UNTIL_TELEMETRY=0)",
          "warning"
        );
        return;
      }
      const events = await readTelemetry(telemetry.filePath);
      ctx.ui.notify(
        summaryText(summarizeTelemetry(events), telemetry.filePath),
        "info"
      );
    },
  });

  pi.registerCommand("until-cancel", {
    description: "Cancel a watch: /until-cancel <id>",
    handler: async (args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "cancel",
        event: "action",
        source: "command",
      });
      const id = args.trim();
      const record = watches.get(id);
      if (!record) {
        ctx.ui.notify(
          `Unknown pi-until watch: ${id || "<missing id>"}`,
          "warning"
        );
        return;
      }
      if (receiptStatus(record) === "running") {
        record.actor.send({ type: "CANCEL" });
      }
      ctx.ui.notify(`Cancelled ${id}`, "info");
    },
  });

  pi.registerCommand("until-complete", {
    description: "Complete a recurring watch: /until-complete <id>",
    handler: async (args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "complete",
        event: "action",
        source: "command",
      });
      const id = args.trim();
      const record = watches.get(id);
      if (!record) {
        ctx.ui.notify(
          `Unknown pi-until watch: ${id || "<missing id>"}`,
          "warning"
        );
        return;
      }
      if (record.actor.getSnapshot().context.definition.kind !== "recurring") {
        ctx.ui.notify(`Watch ${id} is not recurring`, "warning");
        return;
      }
      if (receiptStatus(record) === "running") {
        record.actor.send({ type: "COMPLETE" });
      }
      ctx.ui.notify(`Completed ${id}`, "info");
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    for (const record of activeWatches()) {
      record.actor.send({ type: "SESSION_BUSY" });
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    const at = Date.now();
    for (const record of activeWatches()) {
      record.actor.send({ at, type: "SESSION_SETTLED" });
    }
  });

  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    // Only a reload keeps the same process and session. new/resume/fork
    // replace the session, and a suspension entry from an earlier process
    // must never resurrect watches nobody is running.
    if (event.reason === "reload") {
      resumeWatches(suspendedWatchesFrom(ctx.sessionManager.getBranch()), ctx);
    }
    refreshIndicator();
  });

  pi.on("session_shutdown", async (event) => {
    shuttingDown = true;
    const active = activeWatches();
    if (event.reason === "reload") {
      const suspended = active.map((record) =>
        suspendWatch(record.actor.getSnapshot().context)
      );
      // Written even when empty so the newest entry always wins.
      pi.appendEntry(
        SUSPENDED_ENTRY_TYPE,
        suspensionData(suspended, Date.now())
      );
      if (suspended.length > 0) {
        void track(sessionId(currentContext), {
          count: suspended.length,
          event: "suspended",
        });
      }
    }
    for (const record of active) {
      record.actor.send({ type: "CANCEL" });
    }
    await shellRunner.drain();
    for (const record of active) {
      record.actor.stop();
    }
    watches.clear();
    currentContext?.ui.setWidget(WIDGET_KEY, undefined);
    indicatorMounted = false;
    requestIndicatorRender = undefined;
    currentContext = undefined;
  });
}
