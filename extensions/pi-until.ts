import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { createActor } from "xstate";
import type { ActorRefFrom, SnapshotFrom } from "xstate";

import { createShellConditionRunner } from "../src/check.ts";
import { planCompletion } from "../src/completion.ts";
import { renderWatchIndicator, renderWatchPanel } from "../src/indicator.ts";
import type { WatchDisplay, WatchPhase } from "../src/indicator.ts";
import { createUntilMachine } from "../src/machine.ts";
import type { UntilInput, UntilTerminalState } from "../src/machine.ts";
import {
  SUSPENDED_ENTRY_TYPE,
  remainingTimeoutMs,
  resumeInput,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
} from "../src/suspension.ts";
import type { SuspendedWatch, WatchHistory } from "../src/suspension.ts";
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

const parameters = Type.Object(
  {
    action: StringEnum(["start", "list", "status", "cancel"] as const),
    checkTimeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 3_600,
        description: "Maximum runtime for one check. Defaults to 30.",
      })
    ),
    condition: Type.Optional(
      Type.String({
        description:
          "Side-effect-free shell command. Exit code 0 means the condition is true.",
      })
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory. Defaults to Pi's current directory.",
      })
    ),
    id: Type.Optional(
      Type.String({ description: "Watch ID for status or cancel." })
    ),
    intervalSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 86_400,
        description: "Seconds between checks. Defaults to 30.",
      })
    ),
    label: Type.Optional(
      Type.String({ description: "Short safe label. Do not include secrets." })
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 2_000_000,
        description: "Optional overall watch timeout.",
      })
    ),
    wake: Type.Optional(
      StringEnum(["agent", "notify"] as const, {
        description:
          "Wake the agent with a receipt, or only show a notification. Defaults to agent.",
      })
    ),
  },
  { additionalProperties: false }
);

type UntilParameters = Static<typeof parameters>;
type FinalWatchStatus = UntilTerminalState | "failed";
type WatchStatus = "running" | FinalWatchStatus;
type UntilMachine = ReturnType<typeof createUntilMachine>;
type UntilActor = ActorRefFrom<UntilMachine>;
type UntilSnapshot = SnapshotFrom<UntilMachine>;

const NO_HISTORY: WatchHistory = { attempts: 0, reloads: 0 };

interface WatchRecord {
  readonly actor: UntilActor;
  /** Attempts and reloads from runs before the last `/reload`. */
  readonly history: WatchHistory;
  readonly input: UntilInput;
  failure?: string;
  finishedAt?: number;
  status: WatchStatus;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface PiUntilOptions {
  readonly telemetry?: TelemetrySink;
}

export interface WatchReceipt {
  readonly attempts: number;
  readonly failure?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly label: string;
  readonly lastCheckKilled?: boolean;
  readonly lastCheckedAt?: string;
  readonly lastExitCode?: number;
  readonly reloads: number;
  readonly startedAt: string;
  readonly status: WatchStatus;
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
  snapshot: UntilSnapshot
): UntilTerminalState | undefined {
  if (snapshot.status !== "done") {
    return undefined;
  }
  if (snapshot.matches("succeeded")) return "succeeded";
  if (snapshot.matches("timedOut")) return "timedOut";
  if (snapshot.matches("cancelled")) return "cancelled";
  return undefined;
}

/** Attempts across every run of this watch, including runs before a reload. */
function totalAttempts(record: WatchRecord): number {
  return record.history.attempts + record.actor.getSnapshot().context.attempts;
}

function toReceipt(record: WatchRecord): WatchReceipt {
  const { context } = record.actor.getSnapshot();
  return {
    attempts: totalAttempts(record),
    failure: record.failure,
    finishedAt:
      record.finishedAt === undefined
        ? undefined
        : new Date(record.finishedAt).toISOString(),
    id: context.id,
    label: context.label,
    lastCheckedAt:
      context.lastCheckedAt === undefined
        ? undefined
        : new Date(context.lastCheckedAt).toISOString(),
    lastCheckKilled: context.lastResult?.killed,
    lastExitCode: context.lastResult?.code,
    reloads: record.history.reloads,
    startedAt: new Date(context.startedAt).toISOString(),
    status: record.status,
    wake: context.wake,
  };
}

function watchPhase(record: WatchRecord): WatchPhase | undefined {
  if (record.status !== "running") return undefined;
  return record.actor.getSnapshot().matches({ running: "sleeping" })
    ? "sleeping"
    : "checking";
}

function receiptText(receipt: WatchReceipt): string {
  const lines = [
    `pi-until watch ${receipt.id}: ${receipt.status}`,
    `Label: ${receipt.label}`,
    `Attempts: ${receipt.attempts}`,
  ];
  if (receipt.reloads > 0) {
    lines.push(`Survived reloads: ${receipt.reloads}`);
  }
  if (receipt.lastExitCode !== undefined) {
    lines.push(`Last exit code: ${receipt.lastExitCode}`);
  }
  if (receipt.lastCheckKilled === true) {
    lines.push("Last check was terminated.");
  }
  if (receipt.failure !== undefined) {
    lines.push(`Failure: ${receipt.failure}`);
  }
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
  const machine = createUntilMachine(shellRunner.run);
  const telemetry =
    options.telemetry ??
    createTelemetrySink(telemetryOptionsFromEnv(process.env));

  const track = telemetry.record;

  const activeWatches = () =>
    [...watches.values()].filter((watch) => watch.status === "running");

  const toWatchDisplay = (record: WatchRecord): WatchDisplay => {
    const { context } = record.actor.getSnapshot();
    return {
      attempts: totalAttempts(record),
      id: context.id,
      intervalMs: context.intervalMs,
      label: context.label,
      lastCheckedAt: context.lastCheckedAt,
      phase: watchPhase(record),
      startedAt: context.startedAt,
      status: record.status,
      wake: context.wake,
    };
  };

  const orderedWatches = () =>
    [...watches.values()].sort((left, right) => {
      const runningDifference =
        Number(right.status === "running") - Number(left.status === "running");
      return runningDifference || right.input.startedAt - left.input.startedAt;
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

  const finishWatch = (record: WatchRecord, status: FinalWatchStatus) => {
    if (record.status !== "running") {
      return;
    }
    record.status = status;
    record.finishedAt = Date.now();
    if (record.timeout) {
      clearTimeout(record.timeout);
    }
    refreshIndicator();
    if (shuttingDown) {
      return;
    }

    const receipt = toReceipt(record);
    void track(sessionId(currentContext), {
      attempts: receipt.attempts,
      conditionHash: describeCondition(record.input.command).hash,
      durationMs: record.finishedAt - record.input.startedAt,
      event: "finished",
      id: receipt.id,
      lastCheckKilled: receipt.lastCheckKilled,
      lastExitCode: receipt.lastExitCode,
      reloads: receipt.reloads,
      status,
      wake: receipt.wake,
    });
    if (status === "cancelled") {
      return;
    }
    pi.appendEntry("pi-until-finished", receipt);

    const plan = planCompletion(status, receipt.wake);
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
        `${record.input.label}: ${plan.summary}`,
        plan.level
      );
    }
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
    if (!params.condition?.trim()) {
      throw new Error("condition is required for action=start");
    }
    if (activeWatches().length >= MAX_ACTIVE_WATCHES) {
      throw new Error(
        `pi-until allows at most ${MAX_ACTIVE_WATCHES} active watches`
      );
    }

    const id = randomUUID().slice(0, 8);
    const cwd = resolve(ctx.cwd, expandPath(params.cwd ?? "."));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }

    const input: UntilInput = {
      checkTimeoutMs:
        (params.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS) * 1_000,
      command: params.condition,
      cwd,
      id,
      intervalMs: (params.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000,
      label: params.label?.trim() || "condition",
      startedAt: Date.now(),
      timeoutMs:
        params.timeoutSeconds === undefined
          ? undefined
          : params.timeoutSeconds * 1_000,
      wake: params.wake ?? "agent",
    };

    const record = runWatch(input, NO_HISTORY, input.timeoutMs);
    pi.appendEntry("pi-until-started", {
      id,
      intervalMs: input.intervalMs,
      label: input.label,
      startedAt: new Date(input.startedAt).toISOString(),
      timeoutMs: input.timeoutMs,
      wake: input.wake,
    });
    const condition = describeCondition(input.command);
    void track(sessionId(ctx), {
      checkTimeoutMs: input.checkTimeoutMs,
      conditionHash: condition.hash,
      conditionHead: condition.head,
      event: "started",
      id,
      intervalMs: input.intervalMs,
      label: input.label,
      resumed: false,
      timeoutMs: input.timeoutMs,
      wake: input.wake,
    });
    return record;
  };

  /** Resume watches suspended by the previous extension instance on `/reload`. */
  const resumeWatches = (
    suspended: readonly SuspendedWatch[],
    ctx: ExtensionContext
  ) => {
    const now = Date.now();
    for (const watch of suspended) {
      if (watches.has(watch.id)) {
        continue;
      }
      const input = resumeInput(watch);
      runWatch(
        input,
        { attempts: watch.attempts, reloads: watch.reloads },
        remainingTimeoutMs(watch, now)
      );
      const condition = describeCondition(input.command);
      void track(sessionId(ctx), {
        checkTimeoutMs: input.checkTimeoutMs,
        conditionHash: condition.hash,
        conditionHead: condition.head,
        event: "started",
        id: input.id,
        intervalMs: input.intervalMs,
        label: input.label,
        resumed: true,
        timeoutMs: input.timeoutMs,
        wake: input.wake,
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

  /** Start the actor for a watch definition. Shared by fresh starts and resumes. */
  const runWatch = (
    input: UntilInput,
    history: WatchHistory,
    timeoutMs: number | undefined
  ): WatchRecord => {
    const actor = createActor(machine, { input });
    const record: WatchRecord = { actor, history, input, status: "running" };
    watches.set(input.id, record);

    actor.subscribe({
      error(error) {
        if (record.status !== "running") {
          return;
        }
        record.failure = error instanceof Error ? error.message : String(error);
        finishWatch(record, "failed");
      },
      next(snapshot) {
        const status = terminalState(snapshot);
        if (status) {
          finishWatch(record, status);
          return;
        }
        refreshIndicator();
      },
    });

    actor.start();
    if (timeoutMs !== undefined) {
      record.timeout = setTimeout(() => {
        actor.send({ type: "TIMEOUT" });
      }, timeoutMs);
    }
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
      "Start, list, inspect, or cancel non-blocking shell-condition watches. A check is true only when its shell command exits 0. Watches survive /reload but stop when this Pi session/process shuts down.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
      void track(sessionId(ctx), {
        action: params.action,
        event: "action",
        source: "tool",
      });
      if (params.action === "start") {
        const record = startWatch(params, ctx);
        const receipt = toReceipt(record);
        return {
          content: [
            {
              type: "text",
              text: `Started pi-until watch ${receipt.id} (${receipt.label}). It will check immediately, then every ${record.input.intervalMs / 1_000}s without blocking this turn.`,
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

      if (params.action === "cancel") {
        if (record.status === "running") record.actor.send({ type: "CANCEL" });
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
    parameters,
    promptGuidelines: [
      "Use until with action=start when work should resume after a side-effect-free shell condition exits 0; do not block bash with polling or sleep loops.",
      "Give until watches a short safe label and never put secrets in labels or commands; pi-until discards condition output.",
      "Use until action=cancel when a pending condition is no longer useful.",
    ],
    promptSnippet:
      "Start, inspect, or cancel non-blocking shell-condition watches",
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
        ctx.ui.notify(
          `Watching ${record.input.label} as ${record.input.id}`,
          "info"
        );
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
      if (record.status === "running") {
        record.actor.send({ type: "CANCEL" });
      }
      ctx.ui.notify(`Cancelled ${id}`, "info");
    },
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
        suspendWatch(
          record.input,
          record.history,
          record.actor.getSnapshot().context.attempts
        )
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
      if (record.timeout) {
        clearTimeout(record.timeout);
      }
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
