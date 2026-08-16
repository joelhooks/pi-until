import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runShellCondition } from "../src/check.ts";

const tempDirectories: string[] = [];

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("shell condition runner", () => {
  it("returns a normal successful exit", async () => {
    const result = await runShellCondition(
      {
        checkTimeoutMs: 1_000,
        command: "true",
        cwd: process.cwd(),
      },
      new AbortController().signal
    );

    expect(result).toEqual({ code: 0, killed: false });
  });

  it("marks a per-check timeout as killed and unsuccessful", async () => {
    const result = await runShellCondition(
      {
        checkTimeoutMs: 20,
        command: "sleep 30",
        cwd: process.cwd(),
      },
      new AbortController().signal
    );

    expect(result).toEqual({ code: 1, killed: true });
  });

  it.skipIf(process.platform === "win32")(
    "force-kills SIGTERM-resistant descendants in the condition process group",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-until-process-tree-"));
      const pidFile = join(directory, "child.pid");
      tempDirectories.push(directory);
      const controller = new AbortController();
      const resultPromise = runShellCondition(
        {
          checkTimeoutMs: 10_000,
          command: `(trap '' TERM HUP; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          cwd: directory,
        },
        controller.signal
      );

      await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
      });
      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      expect(isAlive(childPid)).toBe(true);

      controller.abort();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(isAlive(childPid)).toBe(true);

      await expect(resultPromise).resolves.toEqual({ code: 1, killed: true });
      await vi.waitFor(() => {
        expect(isAlive(childPid)).toBe(false);
      });
    }
  );
});
