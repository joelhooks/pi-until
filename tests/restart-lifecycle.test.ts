import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { newestSuspension, SUSPENDED_ENTRY_TYPE } from "../src/suspension.ts";
import { FakeSession, loadExtension, receiptOf, sleep } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const directories: string[] = [];
const extensions: FakeExtension[] = [];
afterEach(async () => {
  await Promise.all(
    extensions.splice(0).map((extension) => extension.shutdown("quit"))
  );
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "until-exit-"));
  directories.push(directory);
  const session = new FakeSession();
  const extension = loadExtension(session, { handoff: { directory } });
  extensions.push(extension);
  const { ctx } = session.context();
  return { session, extension, ctx, directory };
};
const arm = async (extension: FakeExtension, session: FakeSession) =>
  receiptOf(
    await extension.tool(
      "repeat",
      {
        action: "repeat",
        intervalSeconds: 300,
        timeoutSeconds: 3600,
        instruction: "Inspect fresh fixtures",
        quickRef: "fixture",
        label: "pending fixture",
      },
      new AbortController().signal,
      undefined,
      session.context().ctx
    )
  );

it.each(["exit", "SIGHUP", "SIGTERM"] as const)(
  "journals and publishes synchronously on %s, once across shutdown",
  async (event) => {
    const { session, extension, ctx, directory } = fixture();
    const listeners = () =>
      event === "exit" ? process.listeners("exit") : process.listeners(event);
    const before = new Set<unknown>(listeners());
    await extension.sessionStart("startup", ctx);
    const receipt = await arm(extension, session);
    const hook = listeners().find((listener) => !before.has(listener));
    expect(hook).toBeDefined();
    // Invoke only this fixture's listener. Never send a signal to the test host.
    vi.spyOn(process, "kill").mockReturnValue(true);
    if (hook !== undefined) Reflect.apply(hook, process, [0]);
    const path = join(directory, `${session.id}.json`);
    const published = readFileSync(path, "utf-8");
    expect(
      newestSuspension(session.entries)?.watches.map((watch) => watch.facts.id)
    ).toEqual([receipt.id]);
    if (hook !== undefined) Reflect.apply(hook, process, [0]);
    await extension.shutdown("quit", ctx);
    expect(
      session.entries.filter(
        (entry) =>
          entry.type === "custom" && entry.customType === SUSPENDED_ENTRY_TYPE
      )
    ).toHaveLength(1);
    // A second publication would replace the transfer id and permit replay.
    expect(readFileSync(path, "utf-8")).toBe(published);
    expect(listeners()).not.toContain(hook);
  }
);

it("journals on a caught signal but waits for host settlement to publish", async () => {
  const { session, extension, ctx, directory } = fixture();
  const host = vi.fn<() => void>();
  process.on("SIGTERM", host);
  try {
    const before = new Set(process.listeners("SIGTERM"));
    await extension.sessionStart("startup", ctx);
    const receipt = await arm(extension, session);
    const hook = process
      .listeners("SIGTERM")
      .find((listener) => !before.has(listener));
    expect(hook).toBeDefined();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    if (hook !== undefined) Reflect.apply(hook, process, []);
    expect(kill).not.toHaveBeenCalled();
    expect(
      newestSuspension(session.entries)?.watches.map((watch) => watch.facts.id)
    ).toEqual([receipt.id]);
    expect(existsSync(join(directory, `${session.id}.json`))).toBe(false);
    await extension.shutdown("quit", ctx);
    expect(existsSync(join(directory, `${session.id}.json`))).toBe(true);
  } finally {
    process.off("SIGTERM", host);
  }
});

it("keeps an interrupted reload as reload work, not a quit handoff", async () => {
  const { session, extension, ctx, directory } = fixture();
  const before = new Set(process.listeners("exit"));
  await extension.sessionStart("startup", ctx);
  const receipt = await arm(extension, session);
  const hook = process
    .listeners("exit")
    .find((listener) => !before.has(listener));
  const stopping = extension.shutdown("reload", ctx);
  hook?.(129);
  expect(newestSuspension(session.entries)?.reason).toBe("reload");
  expect(existsSync(join(directory, `${session.id}.json`))).toBe(false);
  await stopping;
  const next = loadExtension(session, { handoff: { directory } });
  extensions.push(next);
  await next.sessionStart("reload", ctx);
  const result = await next.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).toMatchObject({ watches: [{ id: receipt.id }] });
});

it("does not create quit authority for an unrelated crash exit", async () => {
  const { session, extension, ctx } = fixture();
  const before = new Set(process.listeners("exit"));
  await extension.sessionStart("startup", ctx);
  await arm(extension, session);
  const hook = process
    .listeners("exit")
    .find((listener) => !before.has(listener));
  expect(hook).toBeDefined();
  if (hook !== undefined) Reflect.apply(hook, process, [1]);
  expect(newestSuspension(session.entries)).toBeUndefined();
});

it("lists pending inherited ids, labels, and deadlines without activating them", async () => {
  const { session, extension, directory } = fixture();
  const receipt = await arm(extension, session);
  const successor = session.fork();
  const next = loadExtension(successor, {
    handoff: {
      directory,
      predecessorId: session.id,
      successorId: successor.id,
    },
  });
  extensions.push(next);
  const { ctx } = successor.context();
  await next.sessionStart("startup", ctx);
  const result = await next.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).toMatchObject({
    watches: [],
    handoffPending: {
      predecessorId: session.id,
      watches: [
        {
          id: receipt.id,
          label: "pending fixture",
          expiresAt: receipt.expiresAt,
        },
      ],
    },
  });
  expect(result.content[0]?.text).toContain(receipt.id);
  expect(result.content[0]?.text).toContain("handoff deadline");
  expect(result.content[0]?.text).toContain("do not re-arm");
});

it("writes before awaiting an in-flight shell check's descendant cleanup", async () => {
  const { session, extension, ctx } = fixture();
  await extension.sessionStart("startup", ctx);
  const receipt = receiptOf(
    await extension.tool(
      "start",
      {
        action: "start",
        condition: "sleep 30",
        intervalSeconds: 300,
        timeoutSeconds: 3600,
      },
      new AbortController().signal,
      undefined,
      ctx
    )
  );
  await sleep(40);
  const stopping = extension.shutdown("quit", ctx);
  expect(
    newestSuspension(session.entries)?.watches.map((watch) => watch.facts.id)
  ).toEqual([receipt.id]);
  await stopping;
});

it("writes pending same-session restoration before its filesystem awaits settle", async () => {
  const { session, extension, ctx, directory } = fixture();
  const receipt = await arm(extension, session);
  await extension.shutdown("quit", ctx);
  const next = loadExtension(session, { handoff: { directory } });
  extensions.push(next);
  const starting = next.sessionStart("startup", ctx);
  const stopping = next.shutdown("quit", ctx);
  // session_start is still consuming its old mailbox. No active actor exists yet.
  expect(
    newestSuspension(session.entries)?.watches.map((watch) => watch.facts.id)
  ).toEqual([receipt.id]);
  expect(
    next.entries.filter((entry) => entry.customType === SUSPENDED_ENTRY_TYPE)
  ).toHaveLength(1);
  await Promise.all([starting, stopping]);
  expect(
    newestSuspension(session.entries)?.watches.map((watch) => watch.facts.id)
  ).toEqual([receipt.id]);
});
