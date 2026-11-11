import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  CAUGHT_SIGNAL_WARNING_MS,
  registerExitPersistence,
} from "../src/exit-hooks.ts";

const installedModule = process.env.PI_UNTIL_SIGNAL_EXIT_MODULE;
const modes = [
  "bare",
  "v3",
  "v4",
  ...(installedModule === undefined ? [] : ["installed"]),
];
const cases = modes.flatMap((mode) =>
  [1, 2].flatMap((count) =>
    ["SIGHUP", "SIGTERM"].map((signal) => ({ mode, count, signal }))
  )
);

it.each(cases)(
  "re-raises real $signal with $mode signal-exit and $count instances",
  ({ mode, count, signal }) => {
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
      import { createRequire } from 'node:module';
      import { registerExitPersistence } from ${JSON.stringify(new URL("../src/exit-hooks.ts", import.meta.url).href)};
      const signal = ${JSON.stringify(signal)};
      const mode = ${JSON.stringify(mode)};
      const write = (event) => appendFileSync(${JSON.stringify(proof)}, JSON.stringify(event)+'\\n');
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => { write({kind:'kill', signal}); return kill(pid, signal); };
      if (mode === 'installed') {
        const loaded = createRequire(import.meta.url)(${JSON.stringify(installedModule)});
        (loaded.onExit ?? loaded)((code, signal) => write({kind:'signal-exit', signal}));
      } else if (mode !== 'bare') {
        // Exact v3/v4 count ownership shape and v3's mutually waiting listener.
        const emitter = { count: 1 };
        process[mode === 'v3' ? '__signal_exit_emitter__' : Symbol.for('signal-exit emitter')] = emitter;
        const listener = () => {
          if (process.listeners(signal).length !== emitter.count) return;
          process.off(signal, listener);
          emitter.count -= 1;
          write({kind:'signal-exit', signal});
          process.kill(process.pid, signal);
        };
        process.on(signal, listener);
      }
      for (let index=0; index<${count}; index++) {
        const install = index === 0 ? registerExitPersistence : (await import(${JSON.stringify(new URL("../src/exit-hooks.ts?duplicate", import.meta.url).href)})).registerExitPersistence;
        install({
          signal: () => write({kind:'journal', index}),
          exit: () => write({kind:'publish', index}),
        });
      }
      write({kind:'listeners', count:process.listenerCount(signal)});
      // Keep alive long enough to expose a swallowed real signal, not a
      // synthetic process.emit followed by natural exit.
      setTimeout(() => { write({kind:'still-alive'}); process.exit(97); }, 1500);
      process.kill(process.pid, signal);
    `,
        ],
        { encoding: "utf-8", timeout: 10_000 }
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBe(signal);
      const rows: { kind: string; count?: number; signal?: string }[] =
        readFileSync(proof, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      expect(rows.find((row) => row.kind === "listeners")?.count).toBe(
        mode === "bare" ? 1 : 2
      );
      expect(rows.filter((row) => row.kind === "journal")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "publish")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "kill")).toHaveLength(
        mode === "bare" ? 2 : 3
      );
      expect(rows.filter((row) => row.kind === "still-alive")).toEqual([]);
      expect(rows.filter((row) => row.kind === "signal-exit")).toHaveLength(
        mode === "bare" ? 0 : 1
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

it("lets a once-only host finish settling before signal publication", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeSync } from 'node:fs';
    import { registerExitPersistence } from ${JSON.stringify(new URL("../src/exit-hooks.ts", import.meta.url).href)};
    const events = [];
    process.once('SIGTERM', () => setTimeout(() => { events.push('host-settled'); process.exit(0); }, 10));
    registerExitPersistence({
      signal: () => events.push('journal'),
      exit: () => { events.push('publish'); writeSync(1, JSON.stringify(events)); },
    });
    setTimeout(() => process.exit(97), 1500);
    process.kill(process.pid, 'SIGTERM');
  `,
    ],
    { encoding: "utf-8", timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    "journal",
    "host-settled",
    "publish",
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

it("observes a surviving host once and cancels the delayed observation on teardown", async () => {
  vi.useFakeTimers();
  const before = new Set(process.listeners("SIGTERM"));
  const host = vi.fn<() => void>();
  process.on("SIGTERM", host);
  const stillAlive =
    vi.fn<(signal: "SIGHUP" | "SIGTERM", delayMs: number) => void>();
  const remove = registerExitPersistence({
    signal: vi.fn<() => void>(),
    exit: vi.fn<() => void>(),
    stillAlive,
  });
  try {
    const hook = process
      .listeners("SIGTERM")
      .find((listener) => !before.has(listener) && listener !== host);
    expect(hook).toBeDefined();
    if (hook !== undefined) Reflect.apply(hook, process, []);
    await vi.advanceTimersByTimeAsync(CAUGHT_SIGNAL_WARNING_MS);
    expect(stillAlive).toHaveBeenCalledExactlyOnceWith(
      "SIGTERM",
      CAUGHT_SIGNAL_WARNING_MS
    );
    if (hook !== undefined) Reflect.apply(hook, process, []);
    await vi.advanceTimersByTimeAsync(CAUGHT_SIGNAL_WARNING_MS);
    expect(stillAlive).toHaveBeenCalledTimes(1);
    const removed = vi.fn<() => void>();
    const stop = registerExitPersistence({
      signal: vi.fn<() => void>(),
      exit: vi.fn<() => void>(),
      stillAlive: removed,
    });
    if (hook !== undefined) Reflect.apply(hook, process, []);
    stop();
    await vi.advanceTimersByTimeAsync(CAUGHT_SIGNAL_WARNING_MS);
    expect(removed).not.toHaveBeenCalled();
  } finally {
    remove();
    process.off("SIGTERM", host);
  }
});
