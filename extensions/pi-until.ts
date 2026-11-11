import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
  dueAt,
  initialFacts,
  wakeOf,
} from "../src/domain.ts";
import type {
  ContextRef,
  WatchActorInput,
  WatchDefinition,
} from "../src/domain.ts";
import { registerExitPersistence } from "../src/exit-hooks.ts";
import {
  createFollowUpMachine,
  parseExternalFollowUpRequest,
  type FollowUpRequest,
} from "../src/follow-up.ts";
import {
  claimHandoff,
  completeHandoff,
  completeOwnHandoff,
  consumeOwnHandoff,
  claimedHandoffSync,
  quitOwnershipSync,
  prepareHandoff,
  PERSISTENCE_ERRORS_FILE,
  DEFAULT_HANDOFF_WAIT_MS,
  handoffOptionsFromEnv,
  publishHandoffSync,
  pendingWatchSummaries,
  pruneHandoffs,
  discardOwnMailbox,
  MAILBOX_CLEARED_ENTRY_TYPE,
  forkPointFrom,
  staleClaimCount,
  SUCCESSOR_ENTRY_TYPE,
  successorBindingFrom,
} from "../src/handoff.ts";
import type {
  Handoff,
  SuccessorBinding,
  HandoffOptions,
} from "../src/handoff.ts";
import { renderWatchIndicator, renderWatchPanel } from "../src/indicator.ts";
import type { WatchDisplay, WatchPhase } from "../src/indicator.ts";
import { systemJitter } from "../src/jitter.ts";
import type { UntilJitter } from "../src/jitter.ts";
import { createWatchMachine } from "../src/machine.ts";
import type { WatchTerminalState } from "../src/machine.ts";
import {
  renderRecurringExpiredPacket,
  renderRecurringWakePacket,
} from "../src/packet.ts";
import {
  RESUMED_ENTRY_TYPE,
  RESUME_INTENDED_ENTRY_TYPE,
  SUSPENDED_ENTRY_TYPE,
  SUSPENSION_EXTRA_ENTRY_TYPE,
  journalSuspensionData,
  predecessorHandled,
  newestSuspension,
  hasAdoptedTransfer,
  carryRestoration,
  partitionResumable,
  quitSuspensionFor,
  resumeInput,
  resumedData,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
  unfinishedWatches,
} from "../src/suspension.ts";
import type {
  PendingPredecessor,
  PersistedWatch,
  SuspensionRecord,
} from "../src/suspension.ts";
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
export const WATCHES_EVENT = "pi-until:watches";
/**
 * Other extensions emit a version 1 request here to share the session-wide
 * follow-up arbiter. See `parseExternalFollowUpRequest`.
 */
export const FOLLOW_UP_REQUEST_EVENT = "pi-until:follow-up";
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

interface SuccessorWait {
  readonly controller: AbortController;
  task: Promise<void>;
  phase: "waiting" | "watching" | "finished";
  predecessorId: string;
  notBefore?: string;
  depth: number;
  claimed?: Handoff;
  deadline: number;
}

export interface PiUntilOptions {
  readonly clock?: UntilClock;
  /** Environment port for targeted handoff declarations. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly compactionGraceMs?: number;
  readonly followUpDispatchAckMs?: number;
  readonly jitter?: UntilJitter;
  readonly handoff?: HandoffOptions | false;
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

/** Print and JSON runs exit after one prompt, so they never own watches. */
const isShortLived = (ctx: ExtensionContext | undefined) =>
  ctx?.mode === "print" || ctx?.mode === "json";

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

function toReceipt(record: WatchRecord, jitter: UntilJitter): WatchReceipt {
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
        ? new Date(dueAt(definition, facts, jitter)).toISOString()
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

function toWatchDisplay(
  record: WatchRecord,
  jitter: UntilJitter
): WatchDisplay {
  const { definition, facts } = record.actor.getSnapshot().context;
  return {
    attempts: facts.attempts,
    deliveries: facts.deliveries,
    id: facts.id,
    intervalMs: definition.intervalMs,
    kind: definition.kind,
    label: definition.label,
    missedTicks: facts.missedTicks,
    nextDueAt: dueAt(definition, facts, jitter),
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

function lostFollowUpText(request: FollowUpRequest, retrying: boolean): string {
  const subject = `pi-until follow-up ${request.id} for ${request.watchId}`;
  if (retrying) return `${subject} never started; sending it again`;
  if (request.kind === "recurring") {
    return `${subject} was lost twice; skipping this tick`;
  }
  return `${subject} was lost twice; giving up on it`;
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
  const environment = options.environment ?? process.env;
  const handoff = options.handoff ?? handoffOptionsFromEnv(environment);
  let oldClaims = 0;
  let ownership: "local" | "transferred" = "local";
  let lifecycle = 0;
  let pendingRestoration: SuspensionRecord | undefined;
  let restorationTask: Promise<void> | undefined;
  let handoffWait: SuccessorWait | undefined;
  let arbiterState = { since: 0, value: "" };

  const clock = options.clock ?? systemClock;
  const shellRunner = createShellConditionRunner();
  const jitter = options.jitter ?? systemJitter;
  const machine = createWatchMachine(shellRunner.run, clock, jitter);
  const telemetry =
    options.telemetry ??
    createTelemetrySink({
      ...telemetryOptionsFromEnv(process.env),
      now: () => clock.now(),
    });

  const track = telemetry.record;

  const activeWatches = () => [...watches.values()];

  const allReceipts = () => [
    ...activeWatches().map((record) => toReceipt(record, jitter)),
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
      ...activeWatches().map((record) => toWatchDisplay(record, jitter)),
      ...terminalReceipts.map(displayFromReceipt),
    ].sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return runningDifference || right.startedAt - left.startedAt;
    });

  // refreshIndicator runs on every actor snapshot, including check ticks
  // that change nothing a listener can see. Only emit when the display
  // list actually differs from the last one emitted.
  let lastEmittedWatches: string | undefined;
  const emitWatches = () => {
    const display = activeWatches().map((record) =>
      toWatchDisplay(record, jitter)
    );
    const serialized = JSON.stringify(display);
    if (serialized === lastEmittedWatches) return;
    lastEmittedWatches = serialized;
    pi.events.emit(WATCHES_EVENT, display);
  };

  const refreshIndicator = () => {
    emitWatches();
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
              activeWatches().map((record) => toWatchDisplay(record, jitter)),
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
      ...toReceipt(record, jitter),
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
      const plannedDueAt = dueAt(definition, plannedFacts, jitter);
      const receipt = {
        ...toReceipt(record, jitter),
        deliveries: plannedFacts.deliveries,
        deliveryPending: false,
        missedTicks: plannedFacts.missedTicks,
        nextDueAt: new Date(plannedDueAt).toISOString(),
      } satisfies WatchReceipt;
      pi.sendMessage(
        {
          content: renderRecurringWakePacket(definition.snapshot, {
            deliveredAt,
            delivery: plannedFacts.deliveries,
            expiresAt: definition.expiresAt,
            id: facts.id,
            missedTicks: plannedFacts.missedTicks,
            nextDueAt: plannedDueAt,
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
        compactionGraceMs: options.compactionGraceMs,
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
        lost: (request, retrying) => {
          currentContext?.ui.notify(
            lostFollowUpText(request, retrying),
            retrying ? "warning" : "error"
          );
        },
        skipped: (request) => {
          watches
            .get(request.watchId)
            ?.actor.send({ at: clock.now(), type: "DELIVERY_SKIPPED" });
        },
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
    arbiterState = { since: clock.now(), value: "" };
    actor.subscribe((snapshot) => {
      const { value } = snapshot;
      if (value !== arbiterState.value) {
        arbiterState = { since: clock.now(), value };
      }
    });
    actor.start();
    return actor;
  };
  followUps = createSessionFollowUps(true);

  /**
   * One line on the session's follow-up arbiter, shown by `list` only when a
   * wake is waiting or a dispatch is unacknowledged, so a stuck queue is
   * visible without a debugger.
   */
  const arbiterLine = (): string | undefined => {
    const snapshot = followUps.getSnapshot();
    const queued = snapshot.context.queue.length;
    const { value } = snapshot;
    if (value !== "startUncertain" && queued === 0) return undefined;
    const since = new Date(arbiterState.since).toISOString();
    return `arbiter: ${value} since ${since}, ${queued} queued`;
  };
  const pendingHandoffView = () => {
    if (handoffWait === undefined || handoffWait.phase === "finished")
      return null;
    return {
      predecessorId: handoffWait.predecessorId,
      deadline: new Date(handoffWait.deadline).toISOString(),
      phase: handoffWait.phase,
      // The predecessor may still change its watches. These ids describe the
      // fork snapshot only; the actual handoff remains the restoration authority.
      watches: pendingWatchSummaries(
        currentContext?.sessionManager.getBranch() ?? []
      ).filter((watch) => !watches.has(watch.id)),
    };
  };
  const listWithArbiter = (receipts: readonly WatchReceipt[]): string => {
    const waiting =
      handoffWait?.phase === "waiting"
        ? `handoff: waiting for ${handoffWait.predecessorId} until ${new Date(handoffWait.deadline).toISOString()}`
        : undefined;
    const late =
      handoffWait?.phase === "watching"
        ? `handoff: watching for a late handoff from ${handoffWait.predecessorId}`
        : undefined;
    const claims =
      oldClaims > 0
        ? `claimed: ${oldClaims} older than 7 days; retained for inspection`
        : undefined;
    const pending = pendingHandoffView();
    const inventory =
      pending === null
        ? undefined
        : [
            "Handoff pending; do not re-arm these watches. Snapshot inventory (not active here):",
            ...pending.watches.map(
              (watch) =>
                `- ${watch.id} (${watch.label}); watch deadline ${watch.expiresAt ?? "none"}; handoff deadline ${pending.deadline}`
            ),
            ...(pending.watches.length === 0
              ? [
                  "Watch ids are not available in this fork snapshot; waiting for the predecessor's handoff.",
                ]
              : []),
          ].join("\n");
    return [
      pending !== null && receipts.length === 0
        ? "No local watches yet."
        : listText(receipts),
      arbiterLine(),
      waiting,
      late,
      inventory,
      claims,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  };

  /**
   * Tell the arbiter whether an agent run owns the session. Pi reports a
   * compacting session as not idle although no run will settle it, so while
   * compaction is in flight the compaction events own that fact.
   */
  const syncSessionActivity = (ctx: ExtensionContext) => {
    if (followUps.getSnapshot().context.compacting) return;
    followUps.send({
      type: ctx.isIdle() ? "SESSION_SETTLED" : "SESSION_BUSY",
    });
  };

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
    syncSessionActivity(ctx);
    if (isShortLived(ctx)) {
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
      facts: initialFacts(definition, id, startedAt, jitter),
    };
    const record = runWatch(input);
    const receipt = toReceipt(record, jitter);
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

  /**
   * Resume watches from a suspension entry: automatically after `/reload` or
   * after a quit and relaunch of the same session, or explicitly through
   * `/until-resume`.
   */
  const resumeWatches = (
    suspended: readonly PersistedWatch[],
    ctx: ExtensionContext,
    source: "reload" | "restart" | "command" | "successor" = "reload"
  ): number => {
    let resumed = 0;
    for (const watch of suspended) {
      if (watches.has(watch.facts.id)) continue;
      resumed += 1;
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
    if (resumed > 0) {
      void track(sessionId(ctx), { count: resumed, event: "resumed" });
      const origin = {
        command: "from the newest suspension entry",
        reload: "after reload",
        restart: "after Pi restarted this session",
        successor: "from the declared predecessor session",
      }[source];
      ctx.ui.notify(
        `pi-until resumed ${resumed} watch${resumed === 1 ? "" : "es"} ${origin}`,
        "info"
      );
    }
    return resumed;
  };

  const appendSuspension = (
    data: ReturnType<typeof suspensionData>,
    ctx: ExtensionContext,
    pendingPredecessor?: PendingPredecessor
  ) => {
    const before = newestSuspension(ctx.sessionManager.getBranch())?.entryId;
    pi.appendEntry(SUSPENDED_ENTRY_TYPE, journalSuspensionData(data));
    const core = newestSuspension(ctx.sessionManager.getBranch());
    if (core === undefined || core.entryId === before) return null;
    if (
      data.handoff !== undefined ||
      (data.terminalFollowUps?.length ?? 0) > 0 ||
      pendingPredecessor !== undefined
    )
      pi.appendEntry(SUSPENSION_EXTRA_ENTRY_TYPE, {
        from: core.entryId,
        ...(data.handoff === undefined ? {} : { handoff: data.handoff }),
        ...(data.reason !== "quit" || data.terminalFollowUps === undefined
          ? {}
          : { terminalFollowUps: data.terminalFollowUps }),
        ...(pendingPredecessor === undefined ? {} : { pendingPredecessor }),
      });
    return newestSuspension(ctx.sessionManager.getBranch()) ?? null;
  };

  const pendingTerminalRequests = (
    record: SuspensionRecord,
    ctx: ExtensionContext
  ) => {
    const handled = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === "pi-until-wake-handled" &&
        Value.Check(followUpMarkerSchema, entry.data)
      )
        handled.add(entry.data.followUpId);
      if (
        entry.type === "message" &&
        entry.message.role === "custom" &&
        Value.Check(followUpMarkerSchema, entry.message.details)
      )
        handled.add(entry.message.details.followUpId);
    }
    return (record.terminalFollowUps ?? []).filter(
      (request) => !handled.has(request.id)
    );
  };

  /**
   * Resume one suspension entry in a process that did not write it, then
   * mark the entry consumed so no later start can replay it.
   */
  const resumeAcrossProcesses = (
    record: SuspensionRecord,
    ctx: ExtensionContext,
    source: "restart" | "command" | "successor",
    transfer?: { predecessorId: string; transferId: string }
  ) => {
    const now = clock.now();
    const { expired, resumable } = partitionResumable(
      unfinishedWatches(record, ctx.sessionManager.getBranch()),
      now
    );
    const pending = resumable.filter((watch) => !watches.has(watch.facts.id));
    // Journal consumption before actors can emit a follow-up. A transfer's
    // private suspension was already appended to this session, never its parent.
    pi.appendEntry(RESUME_INTENDED_ENTRY_TYPE, {
      from: record.entryId,
      intended: pending.length,
      resumedAt: new Date(now).toISOString(),
      ...transfer,
    });
    const resumed = resumeWatches(pending, ctx, source);
    pi.appendEntry(RESUMED_ENTRY_TYPE, {
      ...resumedData(record.entryId, resumed, expired.length, now),
      intended: pending.length,
      ...transfer,
    });
    for (const request of pendingTerminalRequests(record, ctx)) {
      followUps.send({ request, type: "ENQUEUE" });
    }
    if (expired.length > 0) {
      ctx.ui.notify(
        `Skipped ${expired.length} expired watch${expired.length === 1 ? "" : "es"}`,
        "warning"
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
      ctx.ui.notify(listWithArbiter(orderedReceipts()), "info");
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
      "Start session-scoped shell-condition watches or recurring agent follow-ups. One session arbiter serializes every pi-until wake and holds wakes while Pi compacts. Recurrences use fixed cadence with ±10% jitter and a stable per-watch phase, immutable task snapshots, and explicit completion. Watches come back after /reload or after Pi quits and reopens the same session, including terminal hangup. list shows handoff-pending inventory separately; do not re-arm it. Reading a finished watch with status or cancel drops its queued wake, never an already dispatched wake.",
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
        const receipt = toReceipt(record, jitter);
        const { definition } = record.actor.getSnapshot().context;
        const every = definition.jitter === false ? "every" : "about every";
        const timing =
          definition.kind === "until"
            ? `It will check immediately, then ${every} ${definition.intervalMs / 1_000}s.`
            : `Its first wake is ${definition.first === "now" ? "after this turn" : receipt.nextDueAt}, then ${every} ${definition.intervalMs / 1_000}s until ${receipt.expiresAt}.`;
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
        const pending = pendingHandoffView();
        return {
          content: [{ type: "text", text: listWithArbiter(receipts) }],
          details: {
            watches: receipts,
            ...(pending === null ? {} : { handoffPending: pending }),
          },
        };
      }

      const record = watches.get(command.id);
      const historical = terminalReceiptFor(command.id);
      if (record === undefined) {
        if (historical === undefined) {
          throw new Error(`unknown pi-until watch: ${command.id}`);
        }
        if (command.action === "status" || command.action === "cancel") {
          const dedupeKey = `terminal:${historical.id}:${historical.status}`;
          for (const request of followUps.getSnapshot().context.queue) {
            if (request.dedupeKey === dedupeKey)
              pi.appendEntry("pi-until-wake-handled", {
                followUpId: request.id,
                disposition: "consumed",
              });
          }
          followUps.send({ dedupeKey, type: "DROP" });
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
        const receipt = toReceipt(record, jitter);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      if (command.action === "cancel") {
        if (receiptStatus(record) === "running") {
          record.actor.send({ type: "CANCEL" });
        }
        const receipt = toReceipt(record, jitter);
        return {
          content: [{ type: "text", text: receiptText(receipt) }],
          details: receipt,
        };
      }

      const receipt = toReceipt(record, jitter);
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
      "Use until action=start when work should resume after a side-effect-free shell condition exits 0. Do not block bash with polling or sleep loops.",
      "Write conditions that fail closed: exit 0 must prove fresh, positive evidence from this run, such as grep -qx MARKER file, not the absence of a process or leftover output. Never arm a watch in the same tool batch that writes, moves, or resets what its condition reads; the first check runs immediately.",
      "Before re-arming a result watch, persist consumed item IDs or a source cursor and check that the new predicate rejects handled results. A delayed wake may be stale: act only on unhandled work, and do not replace a watch for a finished task.",
      "Use until action=repeat when the same agent must do work on a fixed cadence with ±10% jitter and a stable per-watch phase. Supply timeoutSeconds, instruction, and quickRef. Pass jitter=false only when exact times matter.",
      "Treat contextRefs as opaque pointers. Read a target only when the recurring instruction requires it.",
      "Keep recurring snapshots short and secret-free. The instruction, quickRef, and contextRefs are immutable private session data.",
      "Call until action=complete only when the recurring goal is achieved. A finished agent turn is not completion.",
      "Call until action=cancel when recurring work should stop without success. Do not continue an expired or failed recurrence unless the user asks.",
      "Reading a finished watch with status or cancel drops only that watch's queued terminal wake. list does not consume wakes, and already dispatched wakes still settle normally.",
      "After Pi restarts, run until action=list before re-arming anything. Watches from a graceful quit or terminal hangup come back on their own when the same session reopens. A targeted successor lists handoff-pending ids separately; wait for adoption instead of re-arming them by hand and creating duplicates.",
      "Use a durable workload scheduler instead when work must survive a crash, session replacement, a new or forked session, or reboot.",
    ],
    promptSnippet:
      "Watch a shell predicate or schedule serialized work in this live Pi session; status or cancel consumes a finished watch's queued wake",
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
        const receipt = toReceipt(record, jitter);
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

  pi.registerCommand("until-resume", {
    description:
      "Resume watches from the newest pi-until suspension entry when automatic restart recovery did not apply; expired, finished, and active watches are skipped",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: "resume",
        event: "action",
        source: "command",
      });
      const record = newestSuspension(ctx.sessionManager.getBranch());
      const candidates =
        record === undefined
          ? []
          : unfinishedWatches(record, ctx.sessionManager.getBranch());
      const { expired, resumable } = partitionResumable(
        candidates,
        clock.now()
      );
      const pending = resumable.filter((watch) => !watches.has(watch.facts.id));
      if (
        record === undefined ||
        (pending.length === 0 &&
          pendingTerminalRequests(record, ctx).length === 0)
      ) {
        let detail = "";
        if (expired.length > 0) detail = ` (${expired.length} expired)`;
        else if (resumable.length > 0) detail = " (already active)";
        ctx.ui.notify(
          `No suspended pi-until watches to resume${detail}`,
          "warning"
        );
        return;
      }
      resumeAcrossProcesses(record, ctx, "command");
      refreshIndicator();
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

  // A wake dispatched while Pi compacts would start a turn on the
  // uncompacted context beside the summarizer. Hold wakes until it ends.
  pi.on("session_before_compact", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "COMPACTION_STARTED" });
  });

  pi.on("session_compact", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "COMPACTION_ENDED" });
  });

  pi.on("session_compact_failed", (_event, ctx) => {
    currentContext = ctx;
    followUps.send({ type: "COMPACTION_ENDED" });
  });

  pi.on("message_start", (event, ctx) => {
    currentContext = ctx;
    if (
      event.message.role !== "custom" ||
      !Value.Check(followUpMarkerSchema, event.message.details)
    ) {
      return;
    }
    const active = followUps.getSnapshot().context.active;
    if (
      active?.kind === "terminal" &&
      active.id === event.message.details.followUpId &&
      active.dedupeKey.startsWith("terminal:")
    )
      pi.appendEntry("pi-until-wake-handled", {
        followUpId: active.id,
        disposition: "delivered",
      });
    followUps.send({
      id: event.message.details.followUpId,
      type: "MESSAGE_STARTED",
    });
  });

  // Other extensions (Bellwether) route their agent wakes through this
  // arbiter so only one follow-up is in flight for the whole session.
  let stopExternalFollowUps: (() => void) | undefined;
  const listenForExternalFollowUps = () => {
    if (stopExternalFollowUps !== undefined) return;
    const off = pi.events.on(FOLLOW_UP_REQUEST_EVENT, (payload) => {
      if (shuttingDown || currentContext === undefined) return;
      const request = parseExternalFollowUpRequest(payload);
      if (request === undefined) return;
      followUps.send({
        request: {
          content: request.content,
          customType: request.customType,
          dedupeKey: `external:${request.source}:${request.id}`,
          details: request.details,
          id: randomUUID(),
          kind: "terminal",
          watchId: `${request.source}:${request.id}`,
        },
        type: "ENQUEUE",
      });
      request.accept();
    });
    stopExternalFollowUps = () => {
      off();
      stopExternalFollowUps = undefined;
    };
  };

  const adoptionErrorText = (
    error: unknown,
    waiting: SuccessorWait,
    ctx: ExtensionContext
  ) => {
    const running = [...watches.keys()].sort();
    const entries = ctx.sessionManager.getBranch();
    const record = newestSuspension(entries);
    const claimed = waiting.claimed;
    const candidates =
      record !== undefined &&
      claimed !== undefined &&
      record.handoff?.transferId === claimed.transferId
        ? unfinishedWatches(record, entries)
        : (claimed?.suspension.watches ?? []);
    const finished = new Set(terminalReceipts.map((receipt) => receipt.id));
    const now = clock.now();
    const missing = candidates
      .filter(
        (watch) =>
          !watches.has(watch.facts.id) &&
          !finished.has(watch.facts.id) &&
          (watch.definition.expiresAt === undefined ||
            watch.definition.expiresAt > now)
      )
      .map((watch) => watch.facts.id)
      .sort();
    const needed =
      claimed === undefined
        ? "unknown until the claim is readable"
        : missing.join(", ") || "none";
    return `pi-until handoff failed: ${error instanceof Error ? error.message : String(error)}. Running watch ids: ${running.join(", ") || "none"}. Needs re-arming: ${needed}. Check handled work and inspect the retained claim before re-arming any other id.`;
  };

  const adoptSuccessor = (ctx: ExtensionContext, binding: SuccessorBinding) => {
    if (
      handoff === false ||
      handoffWait !== undefined ||
      binding.successorId !== sessionId(ctx) ||
      predecessorHandled(ctx.sessionManager.getBranch(), binding.predecessorId)
    )
      return;
    const generation = lifecycle;
    const waitMs = handoff.waitMs ?? DEFAULT_HANDOFF_WAIT_MS;
    const controller = new AbortController();
    const waiting: SuccessorWait = {
      controller,
      task: Promise.resolve(),
      phase: "waiting",
      predecessorId: binding.predecessorId,
      notBefore: binding.notBefore,
      depth: binding.depth ?? 1,
      deadline: clock.now() + waitMs,
    };
    handoffWait = waiting;
    const adoptLink = async (
      link: SuccessorBinding,
      visited: readonly string[]
    ): Promise<void> => {
      // The depth bound and cycle check prevent unbounded transitive claims.
      if ((link.depth ?? 1) > 3 || visited.includes(link.predecessorId)) {
        ctx.ui.notify(
          "pi-until predecessor chain limit or cycle; inspect pending work and re-arm manually",
          "warning"
        );
        return;
      }
      waiting.predecessorId = link.predecessorId;
      waiting.notBefore = link.notBefore;
      waiting.depth = link.depth ?? 1;
      waiting.claimed = undefined;
      waiting.phase = "waiting";
      waiting.deadline = clock.now() + waitMs;
      ctx.ui.setStatus("pi-until-handoff", `waiting for ${link.predecessorId}`);
      ctx.ui.notify(
        `pi-until waiting up to ${waitMs / 1000}s for predecessor ${link.predecessorId}`,
        "info"
      );
      const result = await claimHandoff({
        ...handoff,
        predecessorId: link.predecessorId,
        successorId: sessionId(ctx),
        notBefore: link.notBefore,
        signal: controller.signal,
        passive: true,
        warn: (message) => ctx.ui.notify(message, "warning"),
        onTimeout: (watching) => {
          if (shuttingDown || lifecycle !== generation) return;
          waiting.phase = watching ? "watching" : "finished";
          ctx.ui.setStatus(
            "pi-until-handoff",
            watching
              ? `watching for a late handoff from ${link.predecessorId}`
              : undefined
          );
          ctx.ui.notify(
            watching
              ? "pi-until: nothing to adopt yet; watching for a late handoff"
              : "pi-until: nothing to adopt; late filesystem watch unavailable",
            "warning"
          );
        },
      });
      // Retain an interrupted claim for quit forwarding before the generation guard.
      if (result.kind === "claimed") waiting.claimed = result.handoff;
      if (shuttingDown || lifecycle !== generation || result.kind === "aborted")
        return;
      if (result.kind === "nothing") {
        pi.appendEntry(RESUMED_ENTRY_TYPE, {
          ...resumedData("handoff-empty", 0, 0, clock.now()),
          predecessorId: link.predecessorId,
          intended: 0,
        });
        ctx.ui.notify("pi-until: predecessor had nothing to hand off", "info");
        return;
      }
      if (result.kind === "empty") return;
      if (["watching"].includes(waiting.phase))
        ctx.ui.notify("pi-until late handoff arrived; adopting now", "info");
      const { suspension, transferId, pendingPredecessor } = result.handoff;
      if (!hasAdoptedTransfer(ctx.sessionManager.getBranch(), transferId)) {
        const record = appendSuspension(
          {
            ...suspension,
            handoff: {
              predecessorId: link.predecessorId,
              transferId,
              suspendedAt: suspension.suspendedAt,
            },
            sessionId: sessionId(ctx),
          },
          ctx,
          pendingPredecessor
        );
        if (
          record === null ||
          !hasAdoptedTransfer(ctx.sessionManager.getBranch(), transferId)
        )
          throw new Error(
            "could not read back the adopted suspension; claim retained for inspection"
          );
        resumeAcrossProcesses(record, ctx, "successor", {
          predecessorId: link.predecessorId,
          transferId,
        });
      }
      await completeHandoff({
        directory: handoff.directory,
        predecessorId: link.predecessorId,
        successorId: sessionId(ctx),
        handoff: result.handoff,
      });
      if (
        shuttingDown ||
        lifecycle !== generation ||
        pendingPredecessor === undefined
      )
        return;
      const next = {
        ...pendingPredecessor,
        successorId: sessionId(ctx),
        depth: waiting.depth + 1,
      };
      if (next.depth <= 3) pi.appendEntry(SUCCESSOR_ENTRY_TYPE, next);
      await adoptLink(next, [...visited, link.predecessorId]);
    };
    waiting.task = (async () => {
      try {
        await adoptLink(binding, []);
      } catch (error) {
        ctx.ui.notify(adoptionErrorText(error, waiting, ctx), "error");
      } finally {
        waiting.phase = "finished";
        ctx.ui.setStatus("pi-until-handoff", undefined);
      }
    })();
  };

  const markTransferred = (
    record: SuspensionRecord,
    ctx: ExtensionContext,
    transferId: string | undefined
  ) => {
    const binding = successorBindingFrom(
      ctx.sessionManager.getBranch(),
      sessionId(ctx)
    );
    const predecessorId =
      binding?.predecessorId ?? record.pendingPredecessor?.predecessorId;
    pi.appendEntry(RESUMED_ENTRY_TYPE, {
      ...resumedData(record.entryId, 0, 0, clock.now()),
      intended: 0,
      disposition: "transferred",
      transferId,
      ...(predecessorId === undefined ? {} : { predecessorId }),
    });
  };

  const restoreOwnQuit = async (
    record: SuspensionRecord,
    ctx: ExtensionContext,
    generation: number
  ) => {
    let ownsQuit = true;
    let transferredId: string | undefined;
    if (handoff !== false) {
      try {
        ownsQuit = await consumeOwnHandoff({
          directory: handoff.directory,
          sessionId: sessionId(ctx),
          suspendedAt: record.suspendedAt,
          onTransferred: (id) => {
            transferredId = id;
          },
          warn: (message) => ctx.ui.notify(message, "warning"),
        });
      } catch (error) {
        ctx.ui.notify(
          `pi-until mailbox consume failed: ${String(error)}; restoring the original same-session quit`,
          "warning"
        );
      }
      if (!ownsQuit) {
        pendingRestoration = undefined;
        ownership = "transferred";
      }
      if (shuttingDown || lifecycle !== generation) return;
    }
    if (!ownsQuit) {
      markTransferred(record, ctx, transferredId);
      ctx.ui.notify(
        "pi-until quit entry was already consumed or handed off; nothing to resume",
        "warning"
      );
      return;
    }
    resumeAcrossProcesses(record, ctx, "restart", record.handoff);
    pendingRestoration = undefined;
    if (handoff !== false) {
      try {
        if (record.handoff !== undefined) {
          const { predecessorId, transferId } = record.handoff;
          await completeHandoff({
            directory: handoff.directory,
            predecessorId,
            successorId: sessionId(ctx),
            handoff: {
              transferId,
              suspension: {
                ...suspensionData(
                  record.watches,
                  clock.now(),
                  "quit",
                  predecessorId,
                  record.terminalFollowUps
                ),
                suspendedAt:
                  record.handoff.suspendedAt ??
                  record.suspendedAt ??
                  record.timestamp,
              },
            },
          });
          if (shuttingDown || lifecycle !== generation) return;
        }
        await completeOwnHandoff(handoff.directory, sessionId(ctx));
      } catch (error) {
        ctx.ui.notify(
          `pi-until claim cleanup failed: ${String(error)}; watches remain resumed`,
          "warning"
        );
      }
      // The session_start caller rechecks its generation immediately after
      // awaiting this helper, before it can adopt or touch the indicator.
    }
  };

  const bindSuccessor = (ctx: ExtensionContext, reason: string) => {
    if (
      handoff === false ||
      ownership === "transferred" ||
      isShortLived(ctx) ||
      !["startup", "resume", "reload"].includes(reason)
    )
      return;
    if (
      handoff.successorId === sessionId(ctx) &&
      handoff.predecessorId === undefined
    ) {
      ctx.ui.notify(
        "pi-until target matches but no predecessor was named; nothing adopted",
        "warning"
      );
      return;
    }
    const remembered = successorBindingFrom(
      ctx.sessionManager.getBranch(),
      sessionId(ctx)
    );
    if (remembered !== undefined) {
      adoptSuccessor(ctx, remembered);
      return;
    }
    if (
      handoff.successorId !== sessionId(ctx) ||
      handoff.predecessorId === undefined
    )
      return;
    const binding = {
      predecessorId: handoff.predecessorId,
      successorId: sessionId(ctx),
      notBefore: forkPointFrom(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getHeader()?.timestamp
      ),
      depth: 1,
    };
    pi.appendEntry(SUCCESSOR_ENTRY_TYPE, binding);
    adoptSuccessor(ctx, binding);
  };

  const pruneMailbox = async (ctx: ExtensionContext, generation: number) => {
    if (handoff === false) return;
    const warn = (message: string) => {
      if (!shuttingDown && lifecycle === generation)
        ctx.ui.notify(message, "warning");
    };
    try {
      await pruneHandoffs({ ...handoff, now: clock.now(), warn });
      const count = await staleClaimCount(handoff.directory, clock.now());
      if (!shuttingDown && lifecycle === generation) oldClaims = count;
    } catch {
      warn("pi-until mailbox pruning failed; session recovery is unaffected");
    }
  };

  const terminalRequestsForQuit = () => {
    const delivery = followUps.getSnapshot();
    const requests = [...delivery.context.queue];
    if (
      delivery.context.active !== undefined &&
      !delivery.matches("awaitingSettlement")
    )
      requests.unshift(delivery.context.active);
    return requests.filter(
      (request): request is Extract<FollowUpRequest, { kind: "terminal" }> =>
        request.kind === "terminal" && request.dedupeKey.startsWith("terminal:")
    );
  };

  const restoreAtStart = async (
    ctx: ExtensionContext,
    generation: number,
    reason: string
  ) => {
    if (isShortLived(ctx) || !["reload", "startup", "resume"].includes(reason))
      return;
    const record = quitSuspensionFor(ctx.sessionManager.getBranch(), {
      sessionCreatedAt: ctx.sessionManager.getHeader()?.timestamp,
      sessionId: sessionId(ctx),
    });
    if (record !== undefined) {
      pendingRestoration = record;
      await restoreOwnQuit(record, ctx, generation);
    } else if (reason === "reload") {
      // Only already-dispatched messages survive in Pi's own queue.
      resumeWatches(suspendedWatchesFrom(ctx.sessionManager.getBranch()), ctx);
    }
    if (
      shuttingDown ||
      lifecycle !== generation ||
      handoff === false ||
      reason === "reload"
    )
      return;
    try {
      const cleared = await discardOwnMailbox(
        handoff.directory,
        sessionId(ctx)
      );
      if (cleared && !shuttingDown && lifecycle === generation)
        pi.appendEntry(MAILBOX_CLEARED_ENTRY_TYPE, {
          sessionId: sessionId(ctx),
          clearedAt: new Date(clock.now()).toISOString(),
        });
    } catch {
      ctx.ui.notify(
        "pi-until could not clear its own stale mailbox",
        "warning"
      );
    }
  };

  pi.on("session_start", async (event, ctx) => {
    lifecycle += 1;
    const generation = lifecycle;
    currentContext = ctx;
    ownership = "local";
    shutdownState = undefined;
    installProcessHooks(ctx);
    listenForExternalFollowUps();
    if (shuttingDown) {
      shuttingDown = false;
      followUps = createSessionFollowUps(!ctx.isIdle());
    } else {
      syncSessionActivity(ctx);
    }
    pendingRestoration = undefined;
    restorationTask = undefined;
    restorationTask = restoreAtStart(ctx, generation, event.reason);
    await restorationTask;
    if (shuttingDown || lifecycle !== generation) return;
    bindSuccessor(ctx, event.reason);
    refreshIndicator();
    // Maintenance is independent of ownership restoration and never holds startup.
    void pruneMailbox(ctx, generation);
  });

  const pendingHandoffAtQuit = (
    ctx: ExtensionContext,
    waiting: SuccessorWait | undefined,
    takeClaim: boolean
  ) => {
    const entries = ctx.sessionManager.getBranch();
    if (
      takeClaim &&
      waiting !== undefined &&
      waiting.claimed === undefined &&
      handoff !== false
    ) {
      waiting.claimed = claimedHandoffSync(
        handoff.directory,
        waiting.predecessorId,
        sessionId(ctx),
        waiting.notBefore
      );
    }
    if (
      takeClaim &&
      waiting?.claimed !== undefined &&
      !hasAdoptedTransfer(entries, waiting.claimed.transferId)
    )
      return {
        captured: waiting.claimed,
        identity: {
          predecessorId: waiting.predecessorId,
          transferId: waiting.claimed.transferId,
          suspendedAt: waiting.claimed.suspension.suspendedAt,
        },
        pending: waiting.claimed.pendingPredecessor,
      };
    const binding = successorBindingFrom(entries, sessionId(ctx));
    const pending =
      binding !== undefined &&
      !predecessorHandled(entries, binding.predecessorId)
        ? {
            predecessorId: binding.predecessorId,
            notBefore: binding.notBefore ?? new Date(0).toISOString(),
          }
        : newestSuspension(entries)?.pendingPredecessor;
    return { captured: undefined, identity: undefined, pending };
  };

  const writeShutdownSnapshot = (
    reason: string,
    ctx: ExtensionContext,
    active: readonly PersistedWatch[],
    forwarding: ReturnType<typeof pendingHandoffAtQuit>,
    pendingTerminal: ReturnType<typeof terminalRequestsForQuit>
  ) => {
    let quitData: ReturnType<typeof suspensionData> | undefined;
    // `/reload` restores in the next extension instance. `quit` hands the
    // same record to the next process that opens this session file. A print
    // or JSON run owns no watches, so its quit must not bury a pending entry.
    // Session replacement writes nothing.
    if (
      (reason === "reload" && pendingRestoration === undefined) ||
      (reason === "quit" && !isShortLived(ctx))
    ) {
      const suspended = [
        ...new Map(
          [
            ...(forwarding.captured?.suspension.watches ?? []),
            ...(pendingRestoration === undefined
              ? []
              : unfinishedWatches(
                  pendingRestoration,
                  ctx.sessionManager.getBranch()
                )),
            ...active,
          ].map((watch) => [watch.facts.id, watch])
        ).values(),
      ];
      // Written even when empty so the newest entry always wins.
      const data = carryRestoration(
        suspensionData(
          suspended,
          clock.now(),
          reason,
          sessionId(ctx),
          reason === "quit"
            ? [
                ...new Map(
                  [
                    ...(pendingRestoration === undefined
                      ? []
                      : pendingTerminalRequests(pendingRestoration, ctx)),
                    ...(forwarding.captured?.suspension.terminalFollowUps ??
                      []),
                    ...pendingTerminal,
                  ].map((request) => [request.id, request])
                ).values(),
              ]
            : []
        ),
        pendingRestoration
      );
      const recorded =
        forwarding.identity === undefined
          ? data
          : { ...data, handoff: forwarding.identity };
      appendSuspension(recorded, ctx, forwarding.pending);
      if (reason === "quit") quitData = data;
      if (suspended.length > 0) {
        void track(sessionId(currentContext), {
          count: suspended.length,
          event: "suspended",
        });
      }
    }
    return quitData;
  };

  let shutdownState:
    | {
        readonly reason: string;
        readonly active: readonly WatchRecord[];
        readonly suspendedActive: readonly PersistedWatch[];
        readonly pendingTerminal: ReturnType<typeof terminalRequestsForQuit>;
        readonly closingWait: SuccessorWait | undefined;
        forwarding: ReturnType<typeof pendingHandoffAtQuit>;
        quitData: ReturnType<typeof writeShutdownSnapshot>;
        payload: ReturnType<typeof prepareHandoff> | undefined;
        hadPendingRestoration: boolean;
        journalled: boolean;
        published: boolean;
      }
    | undefined;
  type ShutdownState = NonNullable<typeof shutdownState>;
  let removeProcessHooks: (() => void) | undefined;

  const rejectTransferredRestoration = (ctx: ExtensionContext) => {
    if (pendingRestoration === undefined || handoff === false) return;
    const evidence = quitOwnershipSync({
      directory: handoff.directory,
      sessionId: sessionId(ctx),
      suspendedAt: pendingRestoration.suspendedAt,
    });
    if (evidence.kind !== "transferred") return;
    const record = pendingRestoration;
    pendingRestoration = undefined;
    ownership = "transferred";
    markTransferred(record, ctx, evidence.transferId);
  };

  const journalShutdown = (
    state: NonNullable<typeof shutdownState>,
    ctx: ExtensionContext
  ) => {
    state.journalled = false;
    if (state.reason === "quit") rejectTransferredRestoration(ctx);
    const settled = pendingHandoffAtQuit(
      ctx,
      state.closingWait,
      state.reason === "quit"
    );
    if (
      settled.captured !== undefined ||
      state.forwarding.captured === undefined
    )
      state.forwarding = settled;
    state.quitData = writeShutdownSnapshot(
      state.reason,
      ctx,
      state.suspendedActive,
      state.forwarding,
      state.pendingTerminal
    );
    const transferId =
      state.payload !== undefined && "transferId" in state.payload
        ? state.payload.transferId
        : undefined;
    state.payload =
      state.quitData === undefined
        ? undefined
        : prepareHandoff(state.quitData, state.forwarding.pending, transferId);
    state.hadPendingRestoration = pendingRestoration !== undefined;
    state.journalled = true;
  };

  const beginShutdown = (reason: string, ctx: ExtensionContext) => {
    if (shutdownState !== undefined) {
      if (!shutdownState.journalled) journalShutdown(shutdownState, ctx);
      return shutdownState;
    }
    shuttingDown = true;
    lifecycle += 1;
    const active = activeWatches();
    const suspendedActive = active.map((record) =>
      suspendWatch(record.actor.getSnapshot().context, reason === "reload")
    );
    const closingWait = handoffWait;
    // Claim the boundary before fallible probes or journal I/O. Failed writes
    // retry from these frozen actor values, not from cancelled actor facts.
    const state: ShutdownState = {
      reason,
      active,
      suspendedActive,
      pendingTerminal: terminalRequestsForQuit(),
      closingWait,
      forwarding: {
        captured: undefined,
        identity: undefined,
        pending: undefined,
      },
      quitData: undefined,
      payload: undefined,
      hadPendingRestoration: pendingRestoration !== undefined,
      journalled: false,
      published: false,
    };
    shutdownState = state;
    try {
      // Persist before any cleanup await. Positive foreign ownership evidence
      // can exclude a pending restoration at this synchronous boundary.
      journalShutdown(state, ctx);
    } finally {
      try {
        closingWait?.controller.abort();
        stopExternalFollowUps?.();
        followUps.stop();
      } finally {
        for (const record of active) record.actor.send({ type: "CANCEL" });
      }
    }
    return state;
  };

  const reconcileShutdown = (
    state: NonNullable<typeof shutdownState>,
    ctx: ExtensionContext
  ) => {
    if (state.reason !== "quit" || state.published) return;
    rejectTransferredRestoration(ctx);
    const settled = pendingHandoffAtQuit(ctx, state.closingWait, true);
    // Our first journal may itself mark the captured transfer as adopted.
    // Absence after that journal must not erase watches already captured.
    const forwarding =
      settled.captured === undefined && state.forwarding.captured !== undefined
        ? state.forwarding
        : settled;
    const transferred =
      state.hadPendingRestoration && ownership === "transferred";
    if (
      !transferred &&
      forwarding.captured?.transferId === state.forwarding.captured?.transferId
    )
      return;
    // A rename/ownership check can settle after the first journal. Correct it
    // before the one publication; the newest suspension is authoritative.
    state.forwarding = forwarding;
    journalShutdown(state, ctx);
  };

  const publishShutdown = (state: NonNullable<typeof shutdownState>) => {
    if (state.published || state.payload === undefined || handoff === false)
      return;
    publishHandoffSync(handoff.directory, state.payload, {
      onPublished: () => {
        state.published = true;
      },
    });
  };

  const logPersistenceFailure = (ctx: ExtensionContext, error: unknown) => {
    if (handoff === false) return;
    try {
      mkdirSync(handoff.directory, { recursive: true, mode: 0o700 });
      // Never persist error messages, commands, output, or watch definitions.
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "PERSIST_FAILED";
      appendFileSync(
        join(handoff.directory, PERSISTENCE_ERRORS_FILE),
        `${JSON.stringify({ at: new Date(clock.now()).toISOString(), sessionId: sessionId(ctx), code })}\n`,
        { mode: 0o600 }
      );
    } catch {
      // The storage itself may be unavailable. Never write to a dead terminal.
    }
  };

  const installProcessHooks = (ctx: ExtensionContext) => {
    removeProcessHooks?.();
    const installedSessionId = sessionId(ctx);
    const persist = (publish: boolean) => {
      try {
        let state: NonNullable<typeof shutdownState>;
        try {
          state = beginShutdown("quit", ctx);
        } finally {
          // Stop checks even if the synchronous journal failed.
          shellRunner.kill();
        }
        if (publish) {
          reconcileShutdown(state, ctx);
          publishShutdown(state);
        }
      } catch (error) {
        logPersistenceFailure(ctx, error);
      }
    };
    removeProcessHooks = registerExitPersistence({
      signal: () => persist(false),
      exit: () => persist(true),
      stillAlive: (signal, delayMs) => {
        void track(installedSessionId, {
          event: "signal-held",
          signal,
          delayMs,
        });
      },
    });
  };

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      const state = beginShutdown(event.reason, ctx);
      const { active, closingWait } = state;
      await closingWait?.task;
      await restorationTask;
      reconcileShutdown(state, ctx);
      const { forwarding } = state;
      handoffWait = undefined;
      await shellRunner.drain();
      for (const record of active) {
        record.actor.stop();
      }
      if (
        handoff !== false &&
        forwarding.captured !== undefined &&
        forwarding.identity !== undefined &&
        hasAdoptedTransfer(
          ctx.sessionManager.getBranch(),
          forwarding.captured.transferId
        )
      ) {
        try {
          await completeHandoff({
            directory: handoff.directory,
            predecessorId: forwarding.identity.predecessorId,
            successorId: sessionId(ctx),
            handoff: forwarding.captured,
          });
        } catch {
          ctx.ui.notify(
            "pi-until interrupted claim was journalled but cleanup failed; retained for inspection",
            "warning"
          );
        }
      }
      // Publish only after old checks and their descendants are gone.
      if (state.quitData !== undefined && handoff !== false) {
        try {
          publishShutdown(state);
        } catch (error) {
          ctx.ui.notify(
            state.published
              ? `pi-until handoff was published, but directory durability was not confirmed: ${String(error)}; publication will not be retried`
              : `pi-until could not publish handoff: ${String(error)}; same-session quit recovery remains available`,
            "error"
          );
        }
      }
    } finally {
      if (event.reason !== "quit") removeProcessHooks?.();
    }
    if (event.reason === "quit") removeProcessHooks?.();
    watches.clear();
    terminalReceipts.length = 0;
    currentContext?.ui.setWidget(WIDGET_KEY, undefined);
    indicatorMounted = false;
    requestIndicatorRender = undefined;
    currentContext = undefined;
  });
}
