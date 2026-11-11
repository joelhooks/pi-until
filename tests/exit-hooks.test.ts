import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

it.each([1, 2])(
  "re-raises a signal with %s instances and no host handler",
  (count) => {
    const directory = mkdtempSync(join(tmpdir(), "until-reraise-"));
    const proof = join(directory, "events.jsonl");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { appendFileSync } from 'node:fs';
      import { registerExitPersistence } from ${JSON.stringify(new URL("../src/exit-hooks.ts", import.meta.url).href)};
      const write = (event) => appendFileSync(${JSON.stringify(proof)}, JSON.stringify(event)+'\\n');
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => { write({kind:'kill', signal}); return kill(pid, signal); };
      for (let index=0; index<${count}; index++) {
        const install = index === 0 ? registerExitPersistence : (await import(${JSON.stringify(new URL("../src/exit-hooks.ts?duplicate", import.meta.url).href)})).registerExitPersistence;
        install({
          signal: () => write({kind:'journal', index}),
          exit: () => write({kind:'publish', index}),
        });
      }
      write({kind:'listeners', count:process.listenerCount('SIGTERM')});
      process.emit('SIGTERM', 'SIGTERM');
    `,
        ],
        { encoding: "utf-8", timeout: 10_000 }
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBe("SIGTERM");
      const rows: { kind: string; count?: number; signal?: string }[] =
        readFileSync(proof, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      expect(rows.find((row) => row.kind === "listeners")?.count).toBe(1);
      expect(rows.filter((row) => row.kind === "journal")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "publish")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "kill")).toEqual([
        { kind: "kill", signal: "SIGTERM" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
