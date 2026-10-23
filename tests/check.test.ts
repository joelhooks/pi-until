import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
      const lifeline = join(directory, "lifeline");
      tempDirectories.push(directory);
      execFileSync("mkfifo", [lifeline]);
      // The descendant holds the FIFO's only write end, so the reader sees
      // EOF exactly when the kernel closes it at death. A liveness probe
      // would also see the zombie until launchd reaps it, which under load
      // can outlast any fixed wait.
      const descendantGone = new Promise<void>((resolve, reject) => {
        const reader = createReadStream(lifeline);
        reader.on("error", reject);
        reader.on("end", () => resolve());
        reader.resume();
      });
      let goneEarly = false;
      let settled = false;
      void descendantGone.then(() => {
        goneEarly = !settled;
      });
      const controller = new AbortController();
      const resultPromise = runShellCondition(
        {
          checkTimeoutMs: 10_000,
          command: `(trap '' TERM HUP; exec 3>${JSON.stringify(lifeline)}; while :; do sleep 1; done) & echo $! > ${JSON.stringify(pidFile)}; exec sleep 30`,
          cwd: directory,
        },
        controller.signal
      ).finally(() => {
        settled = true;
      });

      await vi.waitFor(() => {
        expect(existsSync(pidFile)).toBe(true);
      });
      const childPid = Math.trunc(
        Number(readFileSync(pidFile, "utf-8").trim())
      );
      expect(isAlive(childPid)).toBe(true);

      controller.abort();
      await expect(resultPromise).resolves.toEqual({ code: 1, killed: true });
      await descendantGone;
      // SIGTERM alone must not end the descendant: it dies only after the
      // runner escalates to SIGKILL, which is when the result settles.
      expect(goneEarly).toBe(false);
    }
  );
});
