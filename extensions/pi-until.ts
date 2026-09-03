import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createActor } from "xstate";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import { createShellConditionRunner } from "../src/check.ts";
import { systemClock } from "../src/clock.ts";
import type { UntilClock } from "../src/clock.ts";
import {
  parseUntilCommand,
  prepareUntilArguments,
  untilParameters,
} from "../src/command.ts";
import type {
  StartWatchCommand,
  UntilCommand,
  UntilParameters,
} from "../src/command.ts";
import { planCompletion } from "../src/completion.ts";
import {
  advanceAfterTick,
  gateOf,
  initialFacts,
  wakeOf,
} from "../src/domain.ts";
import type {
  ContextRef,
  WatchActorInput,
  WatchDefinition,
} from "../src/domain.ts";
import {
  createFollowUpMachine,
  type FollowUpRequest,
} from "../src/follow-up.ts";
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
  hashCondition,
  readTelemetry,
  summarizeTelemetry,
  summaryText,
  telemetryOptionsFromEnv,
} from "../src/telemetry.ts";
import type { TelemetrySink } from "../src/telemetry.ts";

export { prepareUntilArguments, untilParameters } from "../src/command.ts";

const MAX_ACTIVE_WATCHES = 32;
const MAX_TERMINAL_RECEIPTS = 50;
const WIDGET_KEY = "pi-until-watches";
const PANEL_PAGE_SIZE = 6;
const INDICATOR_REFRESH_MS = 1_000;

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
type FollowUpMachine = ReturnType<typeof createFollowUpMachine>;
type FollowUpActor = ActorRefFrom<FollowUpMachine>;

const followUpMarkerSchema = Type.Object(
  { followUpId: Type.String({ minLength: 1 }) },
  { additionalProperties: true }
);

interface WatchRecord {
  readonly actor: WatchActor;
}

export interface PiUntilOptions {
  readonly clock?: UntilClock;
  readonly followUpDispatchAckMs?: number;
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
  readonly intervalMs: number;
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

function terminalState(
  snapshot: WatchSnapshot
): WatchTerminalState | undefined {
  if (snapshot.status !== "done") return undefined;
  if (snapshot.matches("satisfied")) return "satisfied";
  if (snapshot.matches("completed")) return "completed";
  if (snapshot.matches("expired")) return "expired";
  if (snapshot.matches("cancelled")) return "cancelled";
  if (snapshot.matches("failed")) return "failed";
  return undefined;
}

function receiptStatus(record: WatchRecord): ReceiptStatus {
  const snapshot = record.actor.getSnapshot();
  if (snapshot.status === "error") return "failed";
  const terminal = terminalState(snapshot);
  if (terminal === undefined) return "running";
  if (terminal === "satisfied") return "succeeded";
  if (terminal === "failed") return "failed";
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

function defectFrom(snapshot: WatchSnapshot): string | undefined {
  if (snapshot.context.facts.failure !== undefined) {
    return snapshot.context.facts.failure.message;
  }
  if (snapshot.status !== "error") return undefined;
  return snapshot.error instanceof Error
    ? snapshot.error.message
    : String(snapshot.error);
}

function toReceipt(record: WatchRecord): WatchReceipt {
  const snapshot = record.actor.getSnapshot();
  const { definition, facts } = snapshot.context;
  const status = receiptStatus(record);
  const recurring = definition.kind === "recurring" ? definition : undefined;
  return {
    attempts: facts.attempts,
    contextRefs: recurring?.snapshot.contextRefs,
    defect: defectFrom(snapshot),
    deliveries: facts.deliveries,
    deliveryPending: facts.deliveryPending,
    expiresAt:
      definition.expiresAt === undefined
        ? undefined
        : new Date(definition.expiresAt).toISOString(),
    finishedAt:
      facts.finishedAt === undefined
        ? undefined
        : new Date(facts.finishedAt).toISOString(),
    id: facts.id,
    intervalMs: definition.intervalMs,
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

function toWatchDisplay(record: WatchRecord): WatchDisplay {
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
}

function displayFromReceipt(receipt: WatchReceipt): WatchDisplay {
  return {
    attempts: receipt.attempts,
    deliveries: receipt.deliveries,
    id: receipt.id,
    intervalMs: receipt.intervalMs,
    kind: receipt.kind,
    label: receipt.label,
    missedTicks: receipt.missedTicks,
    nextDueAt:
      receipt.nextDueAt === undefined ? 0 : Date.parse(receipt.nextDueAt),
    startedAt: Date.parse(receipt.startedAt),
    status: receipt.status,
    wake: receipt.wake,
  };
}

function listText(receipts: readonly WatchReceipt[]): string {
  if (receipts.length === 0) return "No pi-until watches.";
  return receipts
    .map(
      (receipt) =>
        `${receipt.id}\t${receipt.status}\t${receipt.label}\tattempts=${receipt.attempts}`
    )
    .join("\n");
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
  const terminalReceipts: WatchReceipt[] = [];
  let currentContext: ExtensionContext | undefined;
  let indicatorMounted = false;
  let requestIndicatorRender: (() => void) | undefined;
  let shuttingDown = false;
  let followUps: FollowUpActor;

  const clock = options.clock ?? systemClock;
  const shellRunner = createShellConditionRunner();
  const machine = createWatchMachine(shellRunner.run, clock);
  const telemetry =
    options.telemetry ??
    createTelemetrySink({
      ...telemetryOptionsFromEnv(process.env),
      now: () => clock.now(),
    });

  const track = telemetry.record;

  const activeWatches = () => [...watches.values()];

  const allReceipts = () => [
    ...activeWatches().map(toReceipt),
    ...terminalReceipts,
  ];

  const terminalReceiptFor = (id: string) =>
    terminalReceipts.find((receipt) => receipt.id === id);

  const orderedReceipts = () =>
    allReceipts().sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return (
        runningDifference ||
        Date.parse(right.startedAt) - Date.parse(left.startedAt)
      );
    });

  const orderedWatchDisplays = () =>
    [
      ...activeWatches().map(toWatchDisplay),
      ...terminalReceipts.map(displayFromReceipt),
    ].sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return runningDifference || right.startedAt - left.startedAt;
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
              clock.now(),
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

  const enqueueTerminalFollowUp = (
    receipt: WatchReceipt,
    customType: string,
    content: string
  ) => {
    followUps.send({
      request: {
        content,
        customType,
        dedupeKey: `terminal:${receipt.id}:${receipt.status}`,
        details: receipt,
        id: randomUUID(),
        kind: "terminal",
        watchId: receipt.id,
      },
      type: "ENQUEUE",
    });
  };

  const finishWatch = (record: WatchRecord) => {
    const snapshot = record.actor.getSnapshot();
    const { definition, facts } = snapshot.context;
    if (watches.get(facts.id) !== record) return;

    const finishedAt = facts.finishedAt ?? clock.now();
    const receipt = {
      ...toReceipt(record),
      finishedAt: new Date(finishedAt).toISOString(),
    } satisfies WatchReceipt;
    watches.delete(facts.id);
    terminalReceipts.unshift(receipt);
    if (terminalReceipts.length > MAX_TERMINAL_RECEIPTS) {
      terminalReceipts.length = MAX_TERMINAL_RECEIPTS;
    }
    if (shuttingDown) return;
    followUps.send({ dedupeKey: `recurring:${facts.id}`, type: "DROP" });
    refreshIndicator();

    const conditionHash = hashCondition(gateOf(definition)?.command ?? "");
    void track(sessionId(currentContext), {
      attempts: receipt.attempts,
      conditionHash,
      deliveries: receipt.deliveries,
      durationMs: finishedAt - facts.startedAt,
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
        enqueueTerminalFollowUp(
          receipt,
          "pi-until-recurring",
          renderRecurringExpiredPacket(definition.snapshot, {
            delivery: facts.deliveries,
            expiresAt: definition.expiresAt,
            id: facts.id,
            missedTicks: facts.missedTicks,
            reloads: facts.reloads,
          })
        );
      } else if (receipt.status === "failed") {
        enqueueTerminalFollowUp(
          receipt,
          "pi-until-recurring",
          `The recurring watch failed. Inspect this receipt before deciding what to do.\n\n${receiptText(receipt)}`
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
      enqueueTerminalFollowUp(
        receipt,
        "pi-until",
        `${plan.instruction}\n\n${receiptText(receipt)}`
      );
    } else {
      currentContext?.ui.notify(
        `${definition.label}: ${plan.summary}`,
        plan.level
      );
    }
  };

  const dispatchFollowUp = (request: FollowUpRequest) => {
    if (shuttingDown) return;
    try {
      if (request.kind === "terminal") {
        pi.sendMessage(
          {
            content: request.content,
            customType: request.customType,
            details: { followUpId: request.id, receipt: request.details },
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true }
        );
        return;
      }

      const record = watches.get(request.watchId);
      if (
        record === undefined ||
        !record.actor.getSnapshot().matches({ active: "duePending" })
      ) {
        followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
        return;
      }
      const { definition, facts } = record.actor.getSnapshot().context;
      if (definition.kind !== "recurring") {
        followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
        return;
      }
      const deliveredAt = request.dispatchedAt ?? clock.now();
      const plannedFacts = advanceAfterTick(
        {
          ...facts,
          deliveries: facts.deliveries + 1,
          deliveryPending: false,
        },
        definition.intervalMs,
        deliveredAt
      );
      const receipt = {
        ...toReceipt(record),
        deliveries: plannedFacts.deliveries,
        deliveryPending: false,
        missedTicks: plannedFacts.missedTicks,
        nextDueAt: new Date(plannedFacts.nextDueAt).toISOString(),
      } satisfies WatchReceipt;
      pi.sendMessage(
        {
          content: renderRecurringWakePacket(definition.snapshot, {
            deliveredAt,
            delivery: plannedFacts.deliveries,
            expiresAt: definition.expiresAt,
            id: facts.id,
            missedTicks: plannedFacts.missedTicks,
            nextDueAt: plannedFacts.nextDueAt,
            reloads: facts.reloads,
          }),
          customType: "pi-until-recurring",
          details: { followUpId: request.id, receipt },
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true }
      );
    } catch {
      followUps.send({ id: request.id, type: "DISPATCH_FAILED" });
    }
  };

  const createSessionFollowUps = (sessionBusy: boolean): FollowUpActor => {
    const actor = createActor(
      createFollowUpMachine({
        dispatch: dispatchFollowUp,
        dispatchAckMs: options.followUpDispatchAckMs,
        failed: (request) => {
          const record = watches.get(request.watchId);
          if (request.kind === "recurring" && record !== undefined) {
            record.actor.send({
              failure: {
                kind: "delivery",
                message: "Pi did not accept the follow-up message",
              },
              type: "DELIVERY_FAILED",
            });
            return;
          }
          currentContext?.ui.notify(
            `pi-until could not deliver follow-up for ${request.watchId}`,
            "error"
          );
        },
        isLive: (request) =>
          request.kind === "terminal" || watches.has(request.watchId),
        settled: (request) => {
          if (request.kind !== "recurring") return;
          watches
            .get(request.watchId)
            ?.actor.send({ at: clock.now(), type: "DELIVERY_SETTLED" });
        },
        started: (request) => {
          if (request.kind !== "recurring") return;
          watches.get(request.watchId)?.actor.send({
            at: request.dispatchedAt ?? clock.now(),
            type: "DELIVERY_STARTED",
          });
        },
        unacknowledged: (request) => {
          currentContext?.ui.notify(
            `pi-until is still waiting for Pi to start follow-up ${request.id}; its delivery queue is paused`,
            "warning"
          );
        },
        now: () => clock.now(),
      }),
      { clock, input: { sessionBusy } }
    );
    actor.start();
    return actor;
  };
  followUps = createSessionFollowUps(true);

  const parseCommand = (
    params: UntilParameters,
    ctx: ExtensionContext
  ): UntilCommand =>
    parseUntilCommand(params, {
      cwd: ctx.cwd,
      entryId: ctx.sessionManager.getLeafId() ?? undefined,
      sessionId: sessionId(ctx),
      startedAt: clock.now(),
    });

  const startWatch = (
    command: StartWatchCommand,
    ctx: ExtensionContext
  ): WatchRecord => {
    followUps.send({
      type: ctx.isIdle() ? "SESSION_SETTLED" : "SESSION_BUSY",
    });
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
    const { definition, startedAt } = command;
    const input: WatchActorInput = {
      definition,
      facts: initialFacts(definition, id, startedAt),
    };
    const record = runWatch(input);
    const receipt = toReceipt(record);
    pi.appendEntry("pi-until-started", {
      receipt,
      snapshot:
        definition.kind === "recurring" ? definition.snapshot : undefined,
    });
    const gate = gateOf(definition);
    const conditionHash = hashCondition(gate?.command ?? "");
    void track(sessionId(ctx), {
      checkTimeoutMs: gate?.checkTimeoutMs ?? 0,
      conditionHash,
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
      const input = resumeInput(watch);
      runWatch(input);
      const gate = gateOf(input.definition);
      const conditionHash = hashCondition(gate?.command ?? "");
      void track(sessionId(ctx), {
        checkTimeoutMs: gate?.checkTimeoutMs ?? 0,
        conditionHash,
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
    const actor = createActor(machine, { clock, input });
    const record: WatchRecord = { actor };
    watches.set(input.facts.id, record);

    actor.subscribe({
      error() {
        finishWatch(record);
      },
      next(snapshot) {
        if (snapshot.matches({ active: "duePending" })) {
          followUps.send({
            request: {
              dedupeKey: `recurring:${snapshot.context.facts.id}`,
              id: randomUUID(),
              kind: "recurring",
              watchId: snapshot.context.facts.id,
            },
            type: "ENQUEUE",
          });
        }
        if (
          terminalState(snapshot) !== undefined ||
          snapshot.status === "error"
        ) {
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

  const showWatchPanel = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(listText(orderedReceipts()), "info");
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
            const count = orderedWatchDisplays().length;
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
              orderedWatchDisplays(),
              clock.now(),
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
      const command = parseCommand(params, ctx);
      void track(sessionId(ctx), {
        action: command.action,
        event: "action",
        source: "tool",
      });
      if (command.action === "start" || command.action === "repeat") {
        const record = startWatch(command, ctx);
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

      if (command.action === "list") {
        const receipts = allReceipts();
        return {
          content: [{ type: "text", text: listText(receipts) }],
          details: { watches: receipts },
        };
      }

      const record = watches.get(command.id);
      const historical = terminalReceiptFor(command.id);
      if (record === undefined) {
        if (historical === undefined) {
          throw new Error(`unknown pi-until watch: ${command.id}`);
        }
        return {
          content: [{ type: "text", text: receiptText(historical) }],
          details: historical,
        };
      }

      if (command.action === "complete") {
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

      if (command.action === "cancel") {
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
        const command = parseCommand({ action: "start", condition: args }, ctx);
        if (command.action !== "start") return;
        const record = startWatch(command, ctx);
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
    followUps.send({ type: "SESSION_BUSY" });
  });

  pi.on("agent_settled", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "SESSION_SETTLED" });
  });

  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (
      event.message.role !== "custom" ||
      !Value.Check(followUpMarkerSchema, event.message.details)
    ) {
      return;
    }
    followUps.send({
      id: event.message.details.followUpId,
      type: "MESSAGE_STARTED",
    });
  });

  pi.on("session_start", (event, ctx) => {
    currentContext = ctx;
    if (shuttingDown) {
      shuttingDown = false;
      followUps = createSessionFollowUps(!ctx.isIdle());
    } else {
      followUps.send({
        type: ctx.isIdle() ? "SESSION_SETTLED" : "SESSION_BUSY",
      });
    }
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
    followUps.stop();
    const active = activeWatches();
    if (event.reason === "reload") {
      const suspended = active.map((record) =>
        suspendWatch(record.actor.getSnapshot().context)
      );
      // Written even when empty so the newest entry always wins.
      pi.appendEntry(
        SUSPENDED_ENTRY_TYPE,
        suspensionData(suspended, clock.now())
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
    terminalReceipts.length = 0;
    currentContext?.ui.setWidget(WIDGET_KEY, undefined);
    indicatorMounted = false;
    requestIndicatorRender = undefined;
    currentContext = undefined;
  });
}
