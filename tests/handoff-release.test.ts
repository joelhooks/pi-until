import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { systemClock } from "../src/clock.ts";
import { initialFacts } from "../src/domain.ts";
import type { WatchDefinition } from "../src/domain.ts";
import {
  publishHandoff,
  predecessorDeadlineFrom,
  prepareHandoff,
} from "../src/handoff.ts";
import type { ProcessStart, ProcessStartProbe } from "../src/predecessor.ts";
import { predecessorHandled, suspensionData } from "../src/suspension.ts";
import { FakeSession, loadExtension } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const roots: string[] = [];
const extensions = new Set<FakeExtension>();
afterEach(async () => {
  await Promise.all(
    [...extensions].map((extension) => extension.shutdown("new"))
  );
  extensions.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const waitingSession = async (hasRecord: boolean, waitMs = 40) => {
  const directory = await mkdtemp(join(tmpdir(), "until-ceiling-"));
  roots.push(directory);
  const parent = new FakeSession();
  parent.appendCustom("pi-until-started", {
    receipt: {
      id: "inventory",
      label: "synthetic inventory",
      startedAt: new Date().toISOString(),
    },
  });
  const session = parent.fork();
  const startTime = "2026-11-14T01:02:03.000Z";
  let observed: ProcessStart = { kind: "present", startTime };
  const processStart: ProcessStartProbe = async (pid) =>
    pid === process.pid ? { kind: "present", startTime } : observed;
  if (hasRecord) {
    await mkdir(join(directory, "liveness"), { mode: 0o700 });
    await writeFile(
      join(directory, "liveness", `${parent.id}.json`),
      JSON.stringify({ sessionId: parent.id, pid: 2_147_483_646, startTime }),
      { mode: 0o600 }
    );
  }
  const handoff = {
    directory,
    predecessorId: parent.id,
    successorId: session.id,
    waitMs,
    deathGraceMs: 20,
    processStart,
  };
  const extension = loadExtension(session, { handoff });
  extensions.add(extension);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  const list = () =>
    extension.tool(
      "list",
      { action: "list" },
      new AbortController().signal,
      undefined,
      ctx
    );
  return {
    directory,
    parent,
    session,
    extension,
    handoff,
    ctx,
    notify,
    list,
    observe: (state: ProcessStart) => {
      observed = state;
    },
  };
};

it("does not export a release permission into a forked successor", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  const fork = test.session.fork();
  const child = loadExtension(fork, {
    handoff: {
      ...test.handoff,
      predecessorId: test.session.id,
      successorId: fork.id,
      waitMs: 10_000,
    },
  });
  extensions.add(child);
  const { ctx } = fork.context();
  await child.sessionStart("startup", ctx);
  const result = await child.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).not.toHaveProperty("handoffReleased");
  expect(result.content[0]?.text).not.toContain("Re-arm as needed");
  expect(result.details).toMatchObject({ handoffPending: { watches: [] } });
});

it("hides a foreign release even without a newer successor binding", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  const fork = test.session.fork();
  const child = loadExtension(fork, { handoff: false });
  extensions.add(child);
  const { ctx } = fork.context();
  await child.sessionStart("new", ctx);
  const result = await child.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).not.toHaveProperty("handoffReleased");
  expect(result.content[0]?.text).not.toContain("Re-arm as needed");
});

it.each(["pi-until-resumed", "pi-until-suspended", "pi-until-successor"])(
  "hides a release view after newer %s work",
  async (type) => {
    const test = await waitingSession(false);
    await vi.waitFor(() =>
      expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(
        true
      )
    );
    const before = await test.list();
    expect(before.details).toHaveProperty("handoffReleased");
    test.session.appendCustom(type, {
      receipt: { id: "rearmed", label: "new work" },
    });
    const after = await test.list();
    expect(after.details).not.toHaveProperty("handoffReleased");
  }
);

it("keeps release inventory after a partial re-arm and warns to check active work", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  test.session.appendCustom("pi-until-started", {
    receipt: { id: "fresh-arm", label: "partial re-arm" },
  });
  const after = await test.list();
  expect(after.details).toMatchObject({
    handoffReleased: { inventoryIds: ["inventory"] },
  });
  expect(after.content[0]?.text).toContain("Some ids may already be re-armed");
  expect(after.content[0]?.text).toContain(
    "If `until list` shows a pending handoff, this release does not apply."
  );
});

it("retains released ids through reload before any re-arm", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  await test.extension.shutdown("reload", test.ctx);
  extensions.delete(test.extension);
  const reloaded = loadExtension(test.session, { handoff: test.handoff });
  extensions.add(reloaded);
  await reloaded.sessionStart("reload", test.ctx);
  const after = await reloaded.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    test.ctx
  );
  expect(after.details).toMatchObject({
    watches: [],
    handoffReleased: { inventoryIds: ["inventory"] },
  });
  expect(after.content[0]?.text).toContain("Re-arm as needed");
  expect(reloaded.messages).toHaveLength(0);
});

it("clears released inventory before a later fork lists re-armed ids", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  test.session.appendCustom("pi-until-started", {
    receipt: { id: "rearmed", label: "new work" },
  });
  const fork = test.session.fork();
  const child = loadExtension(fork, {
    handoff: {
      ...test.handoff,
      predecessorId: test.session.id,
      successorId: fork.id,
      waitMs: 10_000,
    },
  });
  extensions.add(child);
  const { ctx } = fork.context();
  await child.sessionStart("startup", ctx);
  const result = await child.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).toMatchObject({
    handoffPending: { watches: [{ id: "rearmed" }] },
  });
  expect(result.content[0]?.text).not.toContain("synthetic inventory");
});

it("reports claimed-elsewhere ownership without conditional re-arm permission", async () => {
  const test = await waitingSession(false, 200);
  await mkdir(join(test.directory, "claimed"), { recursive: true });
  const held = prepareHandoff(
    suspensionData([], Date.now(), "quit", test.parent.id),
    { predecessorId: "ancestor", notBefore: new Date(0).toISOString() }
  );
  await writeFile(
    join(test.directory, "claimed", `${test.parent.id}!other.json`),
    JSON.stringify(held)
  );
  await vi.waitFor(() =>
    expect(test.notify).toHaveBeenCalledWith(
      expect.stringContaining("claimed by another session; do not re-arm"),
      "warning"
    )
  );
  const result = await test.list();
  expect(result.content[0]?.text).toContain(
    "claimed by another session; do not re-arm"
  );
  expect(result.content[0]?.text).not.toContain("re-arm only if");
  expect(result.details).not.toHaveProperty("handoffReleased");
});

it("warns when the identity probe returns unknown without throwing", async () => {
  const test = await waitingSession(false);
  const session = new FakeSession();
  const extension = loadExtension(session, {
    handoff: {
      directory: test.directory,
      processStart: async () => ({ kind: "unknown" }),
    },
  });
  extensions.add(extension);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("could not record process identity"),
    "warning"
  );
});

it("releases a legacy predecessor at the ceiling without claiming it is dead", async () => {
  const test = await waitingSession(false);
  await vi.waitFor(() =>
    expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true)
  );
  const result = await test.list();
  expect(result.details).toMatchObject({
    watches: [],
    handoffReleased: {
      predecessorId: test.parent.id,
      inventoryIds: ["inventory"],
      reason: "deadline-no-record",
    },
  });
  expect(result.content[0]?.text).toContain(
    "never handed off before the deadline"
  );
  expect(result.content[0]?.text).toContain("Re-arm as needed");
  expect(result.content[0]?.text).toContain(
    "may still be running; confirm it has stopped before re-arming"
  );
  expect(result.content[0]?.text).toContain("Reopening that predecessor later");
  expect(result.content[0]?.text).not.toContain("do not re-arm");
  expect(result.content[0]?.text).not.toContain("is gone and");
});

it("keeps an alive predecessor watching past the ceiling and adopts a late publication", async () => {
  const test = await waitingSession(true);
  await vi.waitFor(() =>
    expect(test.notify).toHaveBeenCalledWith(
      expect.stringContaining("may still arrive"),
      "warning"
    )
  );
  const before = await test.list();
  expect(before.details).toMatchObject({
    handoffPending: { phase: "watching" },
  });
  expect(before.content[0]?.text).toContain(
    `re-arm only if ${test.parent.id} is gone`
  );
  expect(before.content[0]?.text).not.toContain("do not re-arm");
  const definition: WatchDefinition = {
    kind: "until",
    label: "late",
    intervalMs: 60_000,
    gate: { command: "false", cwd: tmpdir(), checkTimeoutMs: 1000 },
    wake: "agent",
  };
  await publishHandoff(
    test.directory,
    suspensionData(
      [
        {
          definition,
          facts: initialFacts(definition, "inventory", Date.now()),
        },
      ],
      Date.now(),
      "quit",
      test.parent.id
    )
  );
  await vi.waitFor(async () => {
    const result = await test.list();
    expect(result.details).toMatchObject({ watches: [{ id: "inventory" }] });
  });
  expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true);
});

it("detects death while watching and releases after the death grace", async () => {
  const test = await waitingSession(true);
  await vi.waitFor(() =>
    expect(test.notify).toHaveBeenCalledWith(
      expect.stringContaining("may still arrive"),
      "warning"
    )
  );
  test.observe({ kind: "missing" });
  await vi.waitFor(
    () =>
      expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(
        true
      ),
    { timeout: 3000 }
  );
  const result = await test.list();
  expect(result.details).toMatchObject({
    handoffReleased: { reason: "predecessor-gone" },
  });
});

it("keeps accepting the legacy empty tombstone without a release notice", async () => {
  const test = await waitingSession(false, 1000);
  await publishHandoff(
    test.directory,
    suspensionData([], Date.now(), "quit", test.parent.id)
  );
  await vi.waitFor(() =>
    expect(test.notify).toHaveBeenCalledWith(
      "pi-until: predecessor had nothing to hand off",
      "info"
    )
  );
  const result = await test.list();
  expect(result.content[0]?.text).not.toContain("handoff released");
  expect(result.content[0]?.text).not.toContain("do not re-arm");
  expect(predecessorHandled(test.session.entries, test.parent.id)).toBe(true);
});

it("gives an old carried link with no deadline metadata one ceiling, then releases permanently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-legacy-chain-"));
  roots.push(directory);
  const session = new FakeSession();
  session.appendCustom("pi-until-started", {
    receipt: { id: "legacy-inventory", label: "legacy inventory" },
  });
  await publishHandoff(
    directory,
    suspensionData([], Date.now(), "quit", "legacy-middle"),
    { predecessorId: "legacy-ancestor", notBefore: new Date(0).toISOString() }
  );
  const handoff = {
    directory,
    predecessorId: "legacy-middle",
    successorId: session.id,
    waitMs: 200,
    processStart: async (): Promise<ProcessStart> => ({ kind: "unknown" }),
  };
  const extension = loadExtension(session, { handoff });
  extensions.add(extension);
  const { ctx } = session.context();
  await extension.sessionStart("startup", ctx);
  await vi.waitFor(() =>
    expect(
      predecessorDeadlineFrom(session.entries, "legacy-ancestor")
    ).toBeDefined()
  );
  const deadline = predecessorDeadlineFrom(session.entries, "legacy-ancestor");
  const pending = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(pending.details).toMatchObject({
    handoffPending: { predecessorId: "legacy-ancestor", phase: "waiting" },
  });
  await vi.waitFor(() =>
    expect(predecessorHandled(session.entries, "legacy-ancestor")).toBe(true)
  );
  const released = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(released.content[0]?.text).toContain(
    "never handed off before the deadline"
  );
  expect(released.content[0]?.text).not.toContain("do not re-arm");
  expect(released.details).toMatchObject({
    handoffReleased: {
      inventoryIds: ["legacy-inventory"],
      reason: "deadline-no-record",
    },
  });
  await extension.shutdown("reload", ctx);
  extensions.delete(extension);
  const reloaded = loadExtension(session, { handoff });
  extensions.add(reloaded);
  await reloaded.sessionStart("reload", ctx);
  expect(predecessorDeadlineFrom(session.entries, "legacy-ancestor")).toBe(
    deadline
  );
  expect(reloaded.messages).toHaveLength(0);
  const after = await reloaded.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(after.content[0]?.text).not.toContain("do not re-arm");
  await reloaded.shutdown("quit", ctx);
  extensions.delete(reloaded);
  const finalPublication = JSON.parse(
    await readFile(join(directory, `${session.id}.json`), "utf-8")
  );
  expect(finalPublication).toMatchObject({
    empty: true,
    sessionId: session.id,
  });
  expect(finalPublication).not.toHaveProperty("pendingPredecessor");
});

it("carries the first deadline through a three-session chain without copying deadline journal entries", async () => {
  const middle = await waitingSession(false, 60_000);
  const original = predecessorDeadlineFrom(
    middle.session.entries,
    middle.parent.id
  );
  if (original === undefined) throw new Error("missing original deadline");
  await middle.extension.shutdown("quit", middle.ctx);
  extensions.delete(middle.extension);
  const wire = JSON.parse(
    await readFile(join(middle.directory, `${middle.session.id}.json`), "utf-8")
  );
  expect(Object.keys(wire).sort()).toEqual([
    "pendingPredecessor",
    "suspension",
    "transferId",
  ]);
  expect(Object.keys(wire.pendingPredecessor).sort()).toEqual([
    "notBefore",
    "predecessorId",
  ]);
  const last = new FakeSession();
  last.entries.push(
    ...middle.session.entries.filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "pi-until-started"
    )
  );
  const now = vi.spyOn(Date, "now").mockReturnValue(original + 1);
  try {
    const final = loadExtension(last, {
      clock: { ...systemClock, now: () => Date.now() },
      handoff: {
        ...middle.handoff,
        predecessorId: middle.session.id,
        successorId: last.id,
      },
    });
    extensions.add(final);
    const { ctx } = last.context();
    await final.sessionStart("startup", ctx);
    await vi.waitFor(() =>
      expect(predecessorHandled(last.entries, middle.parent.id)).toBe(true)
    );
    expect(predecessorDeadlineFrom(last.entries, middle.parent.id)).toBe(
      original
    );
    const result = await final.tool(
      "list",
      { action: "list" },
      new AbortController().signal,
      undefined,
      ctx
    );
    expect(result.details).toMatchObject({
      watches: [],
      handoffReleased: {
        predecessorId: middle.parent.id,
        inventoryIds: ["inventory"],
        reason: "deadline-no-record",
      },
    });
    expect(result.content[0]?.text).not.toContain("do not re-arm");
  } finally {
    now.mockRestore();
  }
});

it("releases with predecessor and inventory ids, consumes the binding and ignores a later publication after reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-release-"));
  roots.push(directory);
  const parent = new FakeSession();
  for (const id of ["inventory-a", "inventory-b"]) {
    parent.appendCustom("pi-until-started", {
      receipt: {
        id,
        label: "synthetic inventory",
        startedAt: new Date().toISOString(),
      },
    });
  }
  const session = parent.fork();
  await mkdir(join(directory, "liveness"), { mode: 0o700 });
  const startTime = "2026-11-14T01:02:03.000Z";
  await writeFile(
    join(directory, "liveness", `${parent.id}.json`),
    JSON.stringify({ sessionId: parent.id, pid: 2_147_483_646, startTime }),
    { mode: 0o600 }
  );
  const processStart: ProcessStartProbe = async (pid) =>
    pid === process.pid ? { kind: "present", startTime } : { kind: "missing" };
  const handoff = {
    directory,
    predecessorId: parent.id,
    successorId: session.id,
    deathGraceMs: 20,
    waitMs: 500,
    processStart,
  };
  const extension = loadExtension(session, { handoff });
  extensions.add(extension);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("handoff released"),
      "warning"
    )
  );
  expect(predecessorHandled(session.entries, parent.id)).toBe(true);
  const result = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.content[0]?.text).toContain(parent.id);
  expect(result.content[0]?.text).toContain("inventory-a");
  expect(result.content[0]?.text).toContain("inventory-b");
  expect(result.content[0]?.text).toContain("Re-arm as needed");
  expect(result.content[0]?.text).not.toContain("Handoff pending");
  expect(result.details).toMatchObject({
    watches: [],
    handoffReleased: {
      predecessorId: parent.id,
      inventoryIds: ["inventory-a", "inventory-b"],
    },
  });
  expect(extension.messages).toHaveLength(1);
  expect(extension.messages[0]?.message.customType).toBe(
    "pi-until-handoff-released"
  );
  expect(extension.messages[0]?.options?.triggerTurn).toBe(false);
  await extension.shutdown("reload", ctx);
  extensions.delete(extension);

  const definition: WatchDefinition = {
    kind: "until",
    label: "late",
    intervalMs: 60_000,
    gate: { command: "false", cwd: tmpdir(), checkTimeoutMs: 1000 },
    wake: "agent",
  };
  await publishHandoff(
    directory,
    suspensionData(
      [
        {
          definition,
          facts: initialFacts(definition, "inventory-a", Date.now()),
        },
      ],
      Date.now(),
      "quit",
      parent.id
    )
  );
  const reloaded = loadExtension(session, { handoff });
  extensions.add(reloaded);
  await reloaded.sessionStart("reload", ctx);
  const after = await reloaded.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(after.details).toMatchObject({ watches: [] });
  expect(after.details).toMatchObject({
    handoffReleased: { inventoryIds: ["inventory-a", "inventory-b"] },
  });
  expect(after.content[0]?.text).not.toContain("Handoff pending");
  expect(reloaded.messages).toHaveLength(0);
  expect(await stat(join(directory, `${parent.id}.json`))).toBeDefined();
});

it("records the active session at startup and removes its identity after graceful publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-own-identity-"));
  roots.push(directory);
  const session = new FakeSession();
  const extension = loadExtension(session, { handoff: { directory } });
  extensions.add(extension);
  const { ctx } = session.context();
  await extension.sessionStart("startup", ctx);
  expect(
    await stat(join(directory, "liveness", `${session.id}.json`))
  ).toBeDefined();
  await extension.shutdown("quit", ctx);
  extensions.delete(extension);
  expect(await stat(join(directory, `${session.id}.json`))).toBeDefined();
  await expect(
    stat(join(directory, "liveness", `${session.id}.json`))
  ).rejects.toHaveProperty("code", "ENOENT");
});

it("journals shutdown before awaiting identity registration, then publishes and removes the record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-identity-settle-"));
  roots.push(directory);
  const session = new FakeSession();
  let resolveIdentity:
    | ((value: Awaited<ReturnType<ProcessStartProbe>>) => void)
    | undefined;
  const identity = new Promise<Awaited<ReturnType<ProcessStartProbe>>>(
    (resolve) => {
      resolveIdentity = resolve;
    }
  );
  const probe = vi
    .fn<ProcessStartProbe>()
    .mockImplementation(async () => identity);
  const extension = loadExtension(session, {
    handoff: { directory, processStart: probe },
  });
  extensions.add(extension);
  const { ctx } = session.context();
  const starting = extension.sessionStart("startup", ctx);
  await vi.waitFor(() => expect(probe).toHaveBeenCalled());
  const closing = extension.shutdown("quit", ctx);
  expect(
    session.entries.some(
      (entry) =>
        entry.type === "custom" && entry.customType === "pi-until-suspended"
    )
  ).toBe(true);
  if (resolveIdentity === undefined)
    throw new Error("missing identity resolver");
  resolveIdentity({ kind: "present", startTime: "2026-11-14T01:02:03.000Z" });
  await Promise.all([starting, closing]);
  extensions.delete(extension);
  expect(await stat(join(directory, `${session.id}.json`))).toBeDefined();
  await expect(
    stat(join(directory, "liveness", `${session.id}.json`))
  ).rejects.toHaveProperty("code", "ENOENT");
});

it("does not strand startup when identity registration fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-identity-error-"));
  roots.push(directory);
  const session = new FakeSession();
  const extension = loadExtension(session, {
    handoff: {
      directory,
      processStart: async () => {
        throw new Error("unavailable");
      },
    },
  });
  extensions.add(extension);
  const { ctx, notify } = session.context();
  await extension.sessionStart("startup", ctx);
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("could not record process identity"),
    "warning"
  );
  const result = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    ctx
  );
  expect(result.details).toMatchObject({ watches: [] });
});
