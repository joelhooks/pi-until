import { spawn } from "node:child_process";

import type {
  RunUntilCheck,
  UntilCheckInput,
  UntilCheckResult,
} from "./machine.ts";

const FORCE_KILL_DELAY_MS = 1_000;

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals
): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process tree already exited.
  }
}

const executeShellCondition = async (
  input: UntilCheckInput,
  signal: AbortSignal,
  pids: Set<number>
): Promise<UntilCheckResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(input.command, [], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell:
        process.platform === "win32" ? true : process.env.SHELL || "/bin/sh",
      stdio: "ignore",
    });

    if (child.pid !== undefined) pids.add(child.pid);
    let killed = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      clearTimeout(checkTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      signal.removeEventListener("abort", terminate);
      if (child.pid !== undefined) pids.delete(child.pid);
    }

    function settle(result: UntilCheckResult) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    }

    function terminate() {
      if (settled || killed) {
        return;
      }
      killed = true;
      signalProcessTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child.pid, "SIGKILL");
        forceKillTimer = undefined;
        settle({ code: 1, killed: true });
      }, FORCE_KILL_DELAY_MS);
    }

    const checkTimer = setTimeout(terminate, input.checkTimeoutMs);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) {
      terminate();
    }

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("exit", (code) => {
      if (killed) {
        return;
      }
      settle({
        code: code ?? 1,
        killed: false,
      });
    });
  });

export interface ShellConditionRunner {
  /** Last-resort synchronous termination before publishing from an exit hook. */
  readonly kill: () => void;
  readonly drain: () => Promise<void>;
  readonly run: RunUntilCheck;
}

export const createShellConditionRunner = (): ShellConditionRunner => {
  const active = new Set<Promise<UntilCheckResult>>();
  const pids = new Set<number>();

  const run: RunUntilCheck = (input, signal) => {
    const task = executeShellCondition(input, signal, pids);
    active.add(task);
    void (async () => {
      try {
        await task;
      } catch {
        // The caller receives the original rejection.
      } finally {
        active.delete(task);
      }
    })();
    return task;
  };

  const drain = async (): Promise<void> => {
    await Promise.allSettled(active);
  };

  const kill = () => {
    for (const pid of pids) signalProcessTree(pid, "SIGKILL");
  };

  return { drain, kill, run };
};

const defaultRunner = createShellConditionRunner();
export const runShellCondition = defaultRunner.run;
