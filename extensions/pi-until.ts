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
import type { AnyActorRef } from "xstate";

import { createShellConditionRunner } from "../src/check.ts";
import { planCompletion } from "../src/completion.ts";
import { createUntilMachine } from "../src/machine.ts";
import type {
  UntilContext,
  UntilInput,
  UntilTerminalState,
} from "../src/machine.ts";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 30;
const MAX_ACTIVE_WATCHES = 32;
const STATUS_KEY = "pi-until";

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

interface WatchRecord {
  readonly actor: AnyActorRef;
  readonly input: UntilInput;
  failure?: string;
  finishedAt?: number;
  status: WatchStatus;
  timeout?: ReturnType<typeof setTimeout>;
}

interface WatchReceipt {
  readonly attempts: number;
  readonly failure?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly label: string;
  readonly lastCheckKilled?: boolean;
  readonly lastCheckedAt?: string;
  readonly lastExitCode?: number;
  readonly startedAt: string;
  readonly status: WatchStatus;
  readonly wake: "agent" | "notify";
}

function expandPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function terminalState(value: unknown): UntilTerminalState | undefined {
  if (value === "succeeded" || value === "timedOut" || value === "cancelled") {
    return value;
  }
  return undefined;
}

function toReceipt(record: WatchRecord): WatchReceipt {
  const snapshot = record.actor.getSnapshot();
  const context = snapshot.context as UntilContext;
  return {
    attempts: context.attempts,
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
    startedAt: new Date(context.startedAt).toISOString(),
    status: record.status,
    wake: context.wake,
  };
}

function receiptText(receipt: WatchReceipt): string {
  const lines = [
    `pi-until watch ${receipt.id}: ${receipt.status}`,
    `Label: ${receipt.label}`,
    `Attempts: ${receipt.attempts}`,
  ];
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

export default function piUntil(pi: ExtensionAPI) {
  const watches = new Map<string, WatchRecord>();
  let currentContext: ExtensionContext | undefined;
  let shuttingDown = false;

  const shellRunner = createShellConditionRunner();
  const machine = createUntilMachine(shellRunner.run);

  const activeWatches = () =>
    [...watches.values()].filter((watch) => watch.status === "running");

  const updateStatus = () => {
    const count = activeWatches().length;
    currentContext?.ui.setStatus(
      STATUS_KEY,
      count > 0 ? `until: ${count}` : undefined
    );
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
    updateStatus();
    if (shuttingDown || status === "cancelled") {
      return;
    }

    const receipt = toReceipt(record);
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

    const actor = createActor(machine, { input });
    const record: WatchRecord = { actor, input, status: "running" };
    watches.set(id, record);

    actor.subscribe({
      error(error) {
        if (record.status !== "running") {
          return;
        }
        record.failure = error instanceof Error ? error.message : String(error);
        finishWatch(record, "failed");
      },
      next(snapshot) {
        const status = terminalState(snapshot.value);
        if (snapshot.status === "done" && status) {
          finishWatch(record, status);
        }
      },
    });

    actor.start();
    if (input.timeoutMs !== undefined) {
      record.timeout = setTimeout(() => {
        actor.send({ type: "TIMEOUT" });
      }, input.timeoutMs);
    }
    pi.appendEntry("pi-until-started", {
      id,
      intervalMs: input.intervalMs,
      label: input.label,
      startedAt: new Date(input.startedAt).toISOString(),
      timeoutMs: input.timeoutMs,
      wake: input.wake,
    });
    updateStatus();
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

  pi.registerTool({
    description:
      "Start, list, inspect, or cancel non-blocking shell-condition watches. A check is true only when its shell command exits 0. Active watches stop when this Pi session/process shuts down.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      currentContext = ctx;
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
    description: "List watches owned by this Pi session",
    handler: async (_args, ctx) => {
      currentContext = ctx;
      ctx.ui.notify(listText([...watches.values()]), "info");
    },
  });

  pi.registerCommand("until-cancel", {
    description: "Cancel a watch: /until-cancel <id>",
    handler: async (args, ctx) => {
      currentContext = ctx;
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

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const active = activeWatches();
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
    currentContext?.ui.setStatus(STATUS_KEY, undefined);
    currentContext = undefined;
  });
}
