import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

import piUntil from "../extensions/pi-until.ts";
import type { PiUntilOptions, WatchReceipt } from "../extensions/pi-until.ts";
import type { TelemetryEventInput } from "../src/telemetry.ts";

export interface UntilToolParams {
  action: "start" | "repeat" | "list" | "status" | "complete" | "cancel";
  checkTimeoutSeconds?: number;
  condition?: string;
  contextRefs?: { label: string; target: string }[];
  cwd?: string;
  id?: string;
  immediate?: boolean;
  instruction?: string;
  intervalSeconds?: number;
  label?: string;
  quickRef?: string;
  timeoutSeconds?: number;
  wake?: "agent" | "notify";
}

export interface UntilToolResult {
  content: { type: "text"; text: string }[];
  details?: WatchReceipt | { watches: WatchReceipt[] };
}

/** The single-watch receipt from start/status/cancel results. */
export const receiptOf = (result: UntilToolResult): WatchReceipt => {
  if (result.details === undefined || "watches" in result.details) {
    throw new Error("expected a single watch receipt");
  }
  return result.details;
};

export type UntilToolExecute = (
  toolCallId: string,
  params: UntilToolParams,
  signal: AbortSignal,
  onUpdate: undefined,
  context: ExtensionContext
) => Promise<UntilToolResult>;

export interface SentMessage {
  readonly message: { customType: string; content: string };
  readonly options?: { deliverAs?: string; triggerTurn?: boolean };
}

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionEvent =
  | { type: "session_start"; reason: StartReason }
  | { type: "session_shutdown"; reason: ShutdownReason }
  | { type: "agent_start" }
  | { type: "agent_settled" };

type SessionHandler = (
  event: SessionEvent,
  ctx: ExtensionContext
) => Promise<void> | void;

/**
 * A fake Pi session that persists custom entries the way the real
 * SessionManager does, so several extension instances can share one session
 * across a simulated `/reload`.
 */
export class FakeSession {
  readonly entries: SessionEntry[] = [];
  readonly id = `session-${Math.random().toString(36).slice(2, 8)}`;

  appendCustom(customType: string, data: CustomEntry["data"]): void {
    this.entries.push({
      customType,
      data,
      id: `e${this.entries.length + 1}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
    });
  }

  context(
    overrides: Partial<{
      idle: boolean;
      mode: string;
      notify: ReturnType<typeof vi.fn>;
    }> = {}
  ) {
    const notify = overrides.notify ?? vi.fn();
    const setWidget = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      isIdle: () => overrides.idle ?? true,
      mode: overrides.mode ?? "tui",
      sessionManager: {
        getBranch: () => [...this.entries],
        getLeafId: () => this.entries.at(-1)?.id ?? "origin-entry",
        getSessionId: () => this.id,
      },
      ui: { notify, setWidget },
    };
    // SAFETY: the extension only touches cwd, mode, sessionManager.getBranch,
    // sessionManager.getSessionId, ui.notify, and ui.setWidget. Test doubles
    // for the rest of ExtensionContext would be dead weight.
    return { ctx: ctx as unknown as ExtensionContext, notify, setWidget };
  }
}

export interface FakeExtension {
  readonly agentSettled: (ctx: ExtensionContext) => Promise<void>;
  readonly agentStart: (ctx: ExtensionContext) => Promise<void>;
  readonly appendEntry: ReturnType<typeof vi.fn>;
  readonly commands: Map<
    string,
    (args: string, ctx: ExtensionContext) => Promise<void>
  >;
  readonly entries: { customType: string; data: CustomEntry["data"] }[];
  readonly messages: SentMessage[];
  readonly sendMessage: ReturnType<typeof vi.fn>;
  readonly sessionStart: (
    reason: StartReason,
    ctx: ExtensionContext
  ) => Promise<void>;
  readonly shutdown: (reason: ShutdownReason) => Promise<void>;
  readonly telemetry: TelemetryEventInput[];
  readonly tool: UntilToolExecute;
}

/** Instantiate the extension against a fake Pi bound to `session`. */
export const loadExtension = (
  session: FakeSession,
  options: Pick<PiUntilOptions, "telemetry"> = {}
): FakeExtension => {
  const messages: SentMessage[] = [];
  const entries: { customType: string; data: CustomEntry["data"] }[] = [];
  const telemetry: TelemetryEventInput[] = [];
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionContext) => Promise<void>
  >();
  const handlers = new Map<string, SessionHandler>();
  let tool: UntilToolExecute | undefined;

  const appendEntry = vi.fn((customType: string, data: CustomEntry["data"]) => {
    entries.push({ customType, data });
    session.appendCustom(customType, data);
  });
  const sendMessage = vi.fn(
    (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
      messages.push({ message, options: sendOptions });
    }
  );

  const pi = {
    appendEntry,
    on: vi.fn((event: string, handler: SessionHandler) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn(
      (
        name: string,
        definition: {
          handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        }
      ) => {
        commands.set(name, definition.handler);
      }
    ),
    registerTool: vi.fn((definition: { execute: UntilToolExecute }) => {
      tool = definition.execute;
    }),
    sendMessage,
  };

  // SAFETY: the extension uses only appendEntry, on, registerCommand,
  // registerTool, and sendMessage from ExtensionAPI.
  piUntil(pi as unknown as ExtensionAPI, {
    telemetry: options.telemetry ?? {
      enabled: true,
      filePath: "memory",
      record: async (_sessionId, event) => {
        telemetry.push(event);
      },
    },
  });

  if (!tool) {
    throw new Error("until tool was not registered");
  }

  const emit = async (event: SessionEvent, ctx: ExtensionContext) => {
    await handlers.get(event.type)?.(event, ctx);
  };
  const shutdownContext = session.context().ctx;

  return {
    agentSettled: (ctx) => emit({ type: "agent_settled" }, ctx),
    agentStart: (ctx) => emit({ type: "agent_start" }, ctx),
    appendEntry,
    commands,
    entries,
    messages,
    sendMessage,
    sessionStart: (reason, ctx) => emit({ reason, type: "session_start" }, ctx),
    shutdown: (reason) =>
      emit({ reason, type: "session_shutdown" }, shutdownContext),
    telemetry,
    tool,
  };
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
