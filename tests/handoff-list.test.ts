import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { SimulatedClock } from "xstate";

import { adoptedWatchSources, publishHandoff } from "../src/handoff.ts";
import { newestSuspension, suspensionData } from "../src/suspension.ts";
import { FakeSession, loadExtension, receiptOf } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const roots: string[] = [];
const extensions: FakeExtension[] = [];
afterEach(async () => {
  await Promise.all(
    extensions.splice(0).map((extension) => extension.shutdown("new"))
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const list = (extension: FakeExtension, session: FakeSession) =>
  extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    session.context().ctx
  );

// The production shape: the immediate predecessor owns a live recurrence but
// also carries an unresolved ancestor. A fork inherits the ancestor's history.
const setup = async (waitMs = 10_000) => {
  const directory = await mkdtemp(join(tmpdir(), "until-list-"));
  roots.push(directory);
  const clock = new SimulatedClock();
  clock.set(Date.now());
  const parent = new FakeSession();
  const first = loadExtension(parent, { clock, handoff: { directory } });
  extensions.push(first);
  const receipt = receiptOf(
    await first.tool(
      "arm",
      {
        action: "repeat",
        intervalSeconds: 60,
        timeoutSeconds: 3600,
        instruction: "Inert test task",
        quickRef: "cursor:42",
        jitter: false,
      },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  await first.shutdown("quit");
  const saved = newestSuspension(parent.entries);
  if (saved === undefined) throw new Error("missing parent suspension");
  const ancestor = {
    predecessorId: "old-ancestor",
    notBefore: new Date(0).toISOString(),
  };
  parent.appendCustom("pi-until-successor", {
    ...ancestor,
    successorId: parent.id,
    depth: 1,
  });
  await publishHandoff(
    directory,
    suspensionData(saved.watches, clock.now(), "quit", parent.id),
    ancestor
  );
  const child = parent.fork();
  const successor = loadExtension(child, {
    clock,
    handoff: {
      directory,
      predecessorId: parent.id,
      successorId: child.id,
      waitMs,
    },
  });
  extensions.push(successor);
  await successor.sessionStart("startup", child.context().ctx);
  await vi.waitFor(
    async () => {
      const view = await list(successor, child);
      expect(view.content[0]?.text).toContain("old-ancestor");
      expect(view.details).toMatchObject({
        watches: [{ id: receipt.id, status: "running" }],
      });
      await expect(
        stat(join(directory, "receipts", `${parent.id}!${child.id}.json`))
      ).resolves.toBeDefined();
    },
    { timeout: 5000 }
  );
  return { directory, clock, parent, child, successor, receipt, saved };
};

it("lists adopted active watches separately from an additional pending ancestor", async () => {
  const { parent, child, successor, receipt } = await setup();
  const view = await list(successor, child);
  expect(view.content[0]?.text).toContain(
    "Adopted and active here (do not re-arm):"
  );
  expect(view.content[0]?.text).toContain(
    `- ${receipt.id} (from ${parent.id})`
  );
  expect(view.content[0]?.text).toContain(
    "Additional predecessor handoff (separate from the active watches above):"
  );
  expect(view.content[0]?.text).not.toContain("Watch ids are not available");
  expect(view.content[0]?.text).toContain(
    "No additional watch ids in the snapshot; this does not stop active watches."
  );
});

it("keeps the adopted recurrence firing while its ancestor remains pending", async () => {
  const { clock, child, successor, receipt } = await setup();
  const view = await list(successor, child);
  expect(view.content[0]?.text).toContain("handoff: waiting for old-ancestor");
  if (!receipt.nextDueAt) throw new Error("missing due time");
  clock.increment(Date.parse(receipt.nextDueAt) - clock.now());
  await vi.waitFor(() => expect(successor.messages).toHaveLength(1));
  expect(successor.messages[0]?.message.details).toMatchObject({
    receipt: { id: receipt.id, deliveries: 1 },
  });
});

it("keeps adoption provenance on reload but never attributes it to an untargeted fork", async () => {
  const { directory, clock, parent, child, successor, receipt } = await setup();
  expect(adoptedWatchSources(child.entries, child.id).get(receipt.id)).toBe(
    parent.id
  );
  const fork = child.fork();
  expect([...adoptedWatchSources(fork.entries, fork.id)]).toEqual([]);
  await successor.shutdown("reload");
  const reloaded = loadExtension(child, {
    clock,
    handoff: { directory, waitMs: 1000 },
  });
  extensions.push(reloaded);
  await reloaded.sessionStart("reload", child.context().ctx);
  const view = await list(reloaded, child);
  expect(view.content[0]?.text).toContain(
    `- ${receipt.id} (from ${parent.id})`
  );
  await reloaded.tool(
    "cancel",
    { action: "cancel", id: receipt.id },
    new AbortController().signal,
    undefined,
    child.context().ctx
  );
  const afterCancel = await list(reloaded, child);
  expect(afterCancel.content[0]?.text).not.toContain("Adopted and active here");
});

it("releases the missing ancestor at its ceiling without stopping the adopted recurrence", async () => {
  const { child, successor, receipt } = await setup(1000);
  await vi.waitFor(
    async () => {
      const view = await list(successor, child);
      expect(view.content[0]?.text).not.toContain("handoff: waiting");
      expect(view.details).toMatchObject({
        watches: [{ id: receipt.id, status: "running" }],
      });
      expect(child.entries).toContainEqual(
        expect.objectContaining({
          customType: "pi-until-resumed",
          data: expect.objectContaining({
            from: "handoff-released",
            predecessorId: "old-ancestor",
          }),
        })
      );
    },
    { timeout: 3000 }
  );
});

it("never starts expired watches from a late ancestor publication", async () => {
  const { directory, clock, child, successor, saved, receipt } = await setup();
  const expired = saved.watches.map((watch) => ({
    definition: { ...watch.definition, expiresAt: clock.now() },
    facts: {
      ...watch.facts,
      id: "expired-ancestor-watch",
      deliveryPending: true,
    },
  }));
  await publishHandoff(
    directory,
    suspensionData(expired, clock.now(), "quit", "old-ancestor")
  );
  await vi.waitFor(() =>
    expect(child.entries).toContainEqual(
      expect.objectContaining({
        customType: "pi-until-resumed",
        data: expect.objectContaining({
          predecessorId: "old-ancestor",
          resumed: 0,
          skippedExpired: 1,
        }),
      })
    )
  );
  const view = await list(successor, child);
  expect(view.details).toMatchObject({
    watches: [{ id: receipt.id, status: "running" }],
  });
  expect(
    successor.telemetry
      .filter((event) => event.event === "started")
      .map((event) => event.id)
  ).toEqual([receipt.id]);
  expect(successor.messages).toHaveLength(0);
});
