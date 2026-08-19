import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import piUntil from "../extensions/pi-until.ts";

interface CapturedTool {
  execute: (
    toolCallId: string,
    params: {
      action: "start" | "list" | "status" | "cancel";
      condition?: string;
      id?: string;
      intervalSeconds?: number;
      label?: string;
      timeoutSeconds?: number;
      wake?: "agent" | "notify";
    },
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext
  ) => Promise<{ details?: unknown }>;
}

const shutdownHandlers: (() => Promise<void> | void)[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    shutdownHandlers.splice(0).map(async (shutdown) => {
      await shutdown();
    })
  );
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("pi-until extension", () => {
  it("returns immediately and wakes the agent after a later successful check", async () => {
    let tool: CapturedTool | undefined;
    const directory = mkdtempSync(join(tmpdir(), "pi-until-extension-"));
    const readyFile = join(directory, "ready");
    tempDirectories.push(directory);
    const messages: {
      message: { customType: string; content: string };
      options?: { deliverAs?: string; triggerTurn?: boolean };
    }[] = [];
    const setWidget = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      on: vi.fn((event: string, handler: () => Promise<void> | void) => {
        if (event === "session_shutdown") {
          shutdownHandlers.push(handler);
        }
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
      }),
      sendMessage: vi.fn((message, options) => {
        messages.push({ message, options });
      }),
    } as unknown as ExtensionAPI;

    piUntil(pi);
    if (!tool) {
      throw new Error("until tool was not registered");
    }

    const context = {
      cwd: process.cwd(),
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setWidget,
      },
    } as unknown as ExtensionContext;

    const result = await tool.execute(
      "tool-call",
      {
        action: "start",
        condition: `test -f ${JSON.stringify(readyFile)}`,
        intervalSeconds: 0.005,
        label: "integration test",
        wake: "agent",
      },
      new AbortController().signal,
      undefined,
      context
    );

    expect(result.details).toMatchObject({ status: "running" });
    expect(setWidget).toHaveBeenCalledWith(
      "pi-until-watches",
      expect.any(Function)
    );
    const id = (result.details as { id: string }).id;
    expect(messages).toHaveLength(0);
    writeFileSync(readyFile, "ready\n", "utf-8");

    await vi.waitFor(() => {
      expect(messages).toHaveLength(1);
    });
    const lastWidgetCall = setWidget.mock.calls.at(-1);
    expect(lastWidgetCall?.[0]).toBe("pi-until-watches");
    expect(lastWidgetCall?.[1]).toBeUndefined();

    expect(messages[0]?.message.customType).toBe("pi-until");
    expect(messages[0]?.message.content).toContain("condition is true");
    expect(messages[0]?.message.content).not.toContain(readyFile);
    expect(messages[0]?.message.content).not.toContain("stdout");
    expect(messages[0]?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });

    const firstStatus = await tool.execute(
      "status-1",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      context
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    const secondStatus = await tool.execute(
      "status-2",
      { action: "status", id },
      new AbortController().signal,
      undefined,
      context
    );
    expect(firstStatus.details).toMatchObject({ status: "succeeded" });
    expect((firstStatus.details as { finishedAt: string }).finishedAt).toBe(
      (secondStatus.details as { finishedAt: string }).finishedAt
    );
  });

  it("supports notify-only completion without waking the agent", async () => {
    let tool: CapturedTool | undefined;
    const entries: { customType: string; data: unknown }[] = [];
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const pi = {
      appendEntry: vi.fn((customType, data) => {
        entries.push({ customType, data });
      }),
      on: vi.fn((event: string, handler: () => Promise<void> | void) => {
        if (event === "session_shutdown") {
          shutdownHandlers.push(handler);
        }
      }),
      registerCommand: vi.fn(),
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
      }),
      sendMessage,
    } as unknown as ExtensionAPI;
    piUntil(pi);
    if (!tool) {
      throw new Error("until tool was not registered");
    }
    const context = {
      cwd: process.cwd(),
      mode: "tui",
      ui: { notify, setWidget: vi.fn() },
    } as unknown as ExtensionContext;

    await tool.execute(
      "notify-watch",
      { action: "start", condition: "true", label: "quiet", wake: "notify" },
      new AbortController().signal,
      undefined,
      context
    );

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith("quiet: condition met", "info");
    });
    expect(sendMessage).not.toHaveBeenCalled();
    const finished = entries.find(
      (entry) => entry.customType === "pi-until-finished"
    );
    expect(finished?.data).toMatchObject({ status: "succeeded" });
    expect(finished?.data).not.toHaveProperty("lastOutput");
  });

  it.skipIf(process.platform === "win32")(
    "stops active watches and descendants on session shutdown without waking the agent",
    async () => {
      let tool: CapturedTool | undefined;
      const directory = mkdtempSync(join(tmpdir(), "pi-until-shutdown-"));
      const pidFile = join(directory, "child.pid");
      tempDirectories.push(directory);
      const sendMessage = vi.fn();
      const pi = {
        appendEntry: vi.fn(),
        on: vi.fn((event: string, handler: () => Promise<void> | void) => {
          if (event === "session_shutdown") {
            shutdownHandlers.push(handler);
          }
        }),
        registerCommand: vi.fn(),
        registerTool: vi.fn((definition: CapturedTool) => {
          tool = definition;
        }),
        sendMessage,
      } as unknown as ExtensionAPI;
      piUntil(pi);
      if (!tool) {
        throw new Error("until tool was not registered");
      }
      const context = {
        cwd: process.cwd(),
        mode: "tui",
        ui: { notify: vi.fn(), setWidget: vi.fn() },
      } as unknown as ExtensionContext;

      await tool.execute(
        "shutdown-watch",
        {
          action: "start",
          condition: `(trap '' TERM HUP; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          label: "shutdown",
        },
        new AbortController().signal,
        undefined,
        context
      );
      await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
      });
      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      const shutdown = shutdownHandlers.pop();
      expect(shutdown).toBeDefined();
      await shutdown?.();

      await vi.waitFor(
        () => {
          expect(() => process.kill(childPid, 0)).toThrow();
        },
        { timeout: 2_000 }
      );
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );
});
