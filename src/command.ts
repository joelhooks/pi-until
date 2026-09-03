import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { contextRefSchema } from "./domain.ts";
import type {
  FollowUpSnapshot,
  RecurringDefinition,
  ShellGate,
  UntilDefinition,
} from "./domain.ts";

const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 30;

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

export type UntilParameters = Static<typeof untilParameters>;

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

export interface CommandContext {
  readonly cwd: string;
  readonly entryId?: string;
  readonly sessionId: string;
  readonly startedAt: number;
}

export type UntilCommand =
  | {
      readonly action: "start";
      readonly definition: UntilDefinition;
      readonly startedAt: number;
    }
  | {
      readonly action: "repeat";
      readonly definition: RecurringDefinition;
      readonly startedAt: number;
    }
  | { readonly action: "list" }
  | { readonly action: "status"; readonly id: string }
  | { readonly action: "complete"; readonly id: string }
  | { readonly action: "cancel"; readonly id: string };

export type StartWatchCommand = Extract<
  UntilCommand,
  { action: "start" | "repeat" }
>;

const expandPath = (value: string): string => {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
};

const gateFrom = (
  params: UntilParameters,
  context: CommandContext,
  required: boolean
): ShellGate | undefined => {
  const command = params.condition?.trim();
  if (!command) {
    if (required) throw new Error("condition is required for action=start");
    return undefined;
  }
  const cwd = resolve(context.cwd, expandPath(params.cwd ?? "."));
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

const idFrom = (params: UntilParameters): string => {
  const id = params.id?.trim();
  if (!id) throw new Error(`id is required for action=${params.action}`);
  return id;
};

const intervalFrom = (params: UntilParameters): number =>
  (params.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1_000;

const startCommandFrom = (
  params: UntilParameters,
  context: CommandContext
): UntilCommand => {
  const gate = gateFrom(params, context, true);
  if (gate === undefined) {
    throw new Error("condition is required for action=start");
  }
  const base: UntilDefinition = {
    gate,
    intervalMs: intervalFrom(params),
    kind: "until",
    label: params.label?.trim() || "condition",
    wake: params.wake ?? "agent",
  };
  const definition: UntilDefinition =
    params.timeoutSeconds === undefined
      ? base
      : {
          ...base,
          expiresAt: context.startedAt + params.timeoutSeconds * 1_000,
        };
  return { action: "start", definition, startedAt: context.startedAt };
};

const recurringCommandFrom = (
  params: UntilParameters,
  context: CommandContext
): UntilCommand => {
  const { instruction, quickRef } = params;
  if (!instruction?.trim()) {
    throw new Error("instruction is required for action=repeat");
  }
  if (!quickRef?.trim()) {
    throw new Error("quickRef is required for action=repeat");
  }
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
      Object.freeze({ label: reference.label, target: reference.target })
    )
  );
  if (
    contextRefs.some(
      (reference) => !reference.label.trim() || !reference.target.trim()
    )
  ) {
    throw new Error("contextRefs require non-empty label and target values");
  }
  const origin = Object.freeze(
    context.entryId === undefined
      ? { sessionId: context.sessionId }
      : { entryId: context.entryId, sessionId: context.sessionId }
  );
  const snapshot: FollowUpSnapshot = Object.freeze({
    capturedAt: context.startedAt,
    contextRefs,
    instruction,
    origin,
    quickRef,
  });
  const definition: RecurringDefinition = {
    expiresAt: context.startedAt + params.timeoutSeconds * 1_000,
    first: params.immediate === true ? "now" : "afterInterval",
    gate: gateFrom(params, context, false),
    intervalMs: intervalFrom(params),
    kind: "recurring",
    label: params.label?.trim() || "recurring follow-up",
    snapshot,
  };
  return { action: "repeat", definition, startedAt: context.startedAt };
};

export const parseUntilCommand = (
  params: UntilParameters,
  context: CommandContext
): UntilCommand => {
  if (!Value.Check(untilParameters, params)) {
    throw new Error("invalid until parameters");
  }
  switch (params.action) {
    case "start": {
      return startCommandFrom(params, context);
    }
    case "repeat": {
      return recurringCommandFrom(params, context);
    }
    case "list": {
      return { action: "list" };
    }
    case "status":
    case "complete":
    case "cancel": {
      return { action: params.action, id: idFrom(params) };
    }
    default: {
      const exhaustive: never = params.action;
      throw new Error(`unknown until action: ${String(exhaustive)}`);
    }
  }
};
