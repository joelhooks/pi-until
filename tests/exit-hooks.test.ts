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
const companionModule = process.env.PI_UNTIL_SIGNAL_EXIT_COMPANION_MODULE;
const modes = [
  "bare",
  "v3",
  "v4",
  "v3+v4",
  ...(installedModule === undefined ? [] : ["installed"]),
  ...(installedModule === undefined || companionModule === undefined
    ? []
    : ["installed-both"]),
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
      if (mode.startsWith('installed')) {
        const modules = [${JSON.stringify(installedModule)}];
        if (mode === 'installed-both') modules.push(${JSON.stringify(companionModule)});
        for (const path of modules) {
          const loaded = createRequire(import.meta.url)(path);
          (loaded.onExit ?? loaded)((code, signal) => write({kind:'signal-exit', signal}));
        }
      } else if (mode !== 'bare') {
        const installObserver = (version) => {
          const emitter = { count: 1 };
          if (version === 'v3') process.__signal_exit_emitter__ = emitter;
          else globalThis[Symbol.for('signal-exit emitter')] = emitter;
          const listener = () => {
            const v3count = version === 'v4' ? (process.__signal_exit_emitter__?.count ?? 0) : 0;
            if (process.listeners(signal).length !== emitter.count + v3count) return;
            process.off(signal, listener);
            emitter.count -= 1;
            write({kind:'signal-exit', signal});
            process.kill(process.pid, signal);
          };
          process.on(signal, listener);
        };
        if (mode === 'v3+v4') { installObserver('v3'); installObserver('v4'); }
        else installObserver(mode);
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
      let observers = 1;
      if (mode === "bare") observers = 0;
      else if (mode === "v3+v4" || mode === "installed-both") observers = 2;
      expect(rows.find((row) => row.kind === "listeners")?.count).toBe(
        1 + observers
      );
      expect(rows.filter((row) => row.kind === "journal")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "publish")).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "kill")).toHaveLength(
        2 + observers
      );
      expect(rows.filter((row) => row.kind === "still-alive")).toEqual([]);
      expect(rows.filter((row) => row.kind === "signal-exit")).toHaveLength(
        observers
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

it("isolates a stale client's timer while a live host drains and publishes", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeSync } from 'node:fs';
    import { registerExitPersistence } from ${JSON.stringify(new URL("../src/exit-hooks.ts", import.meta.url).href)};
    const events = [];
    registerExitPersistence({ signal: () => {}, exit: () => {}, stillAlive: () => { throw new Error('This extension ctx is stale'); } });
    registerExitPersistence({
      signal: () => events.push('live journal'),
      stillAlive: () => events.push('host held signal'),
      exit: () => { events.push('live publish'); writeSync(1, JSON.stringify(events)); },
    });
    process.on('SIGTERM', () => {
      events.push('host caught');
      setTimeout(() => { events.push('host drained'); process.exit(0); }, 6000);
    });
    setTimeout(() => process.exit(97), 8000);
    process.kill(process.pid, 'SIGTERM');
  `,
    ],
    { encoding: "utf-8", timeout: 10_000 }
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    "live journal",
    "host caught",
    "host held signal",
    "host drained",
    "live publish",
  ]);
}, 12_000);

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
