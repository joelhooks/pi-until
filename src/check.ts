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

const executeShellCondition: RunUntilCheck = async (
  input: UntilCheckInput,
  signal: AbortSignal
): Promise<UntilCheckResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(input.command, [], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      shell:
        process.platform === "win32" ? true : process.env.SHELL || "/bin/sh",
      stdio: "ignore",
    });

    let killed = false;
    let settled = false;
    const timers: {
      check?: ReturnType<typeof setTimeout>;
      forceKill?: ReturnType<typeof setTimeout>;
    } = {};

    function cleanup() {
      if (timers.check !== undefined) {
        clearTimeout(timers.check);
      }
      if (timers.forceKill !== undefined) {
        clearTimeout(timers.forceKill);
      }
      signal.removeEventListener("abort", terminate);
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
      timers.forceKill = setTimeout(() => {
        signalProcessTree(child.pid, "SIGKILL");
        timers.forceKill = undefined;
        settle({ code: 1, killed: true });
      }, FORCE_KILL_DELAY_MS);
    }

    timers.check = setTimeout(terminate, input.checkTimeoutMs);
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
  readonly drain: () => Promise<void>;
  readonly run: RunUntilCheck;
}

export const createShellConditionRunner = (): ShellConditionRunner => {
  const active = new Set<Promise<UntilCheckResult>>();

  const run: RunUntilCheck = (input, signal) => {
    const task = executeShellCondition(input, signal);
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

  return { drain, run };
};

const defaultRunner = createShellConditionRunner();
export const runShellCondition = defaultRunner.run;
