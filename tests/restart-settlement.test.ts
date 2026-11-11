import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as handoff from "../src/handoff.ts";
import { newestSuspension, SUSPENDED_ENTRY_TYPE } from "../src/suspension.ts";
import { FakeSession, loadExtension, receiptOf } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock("../src/handoff.ts", { spy: true });

const directories: string[] = [];
const extensions: FakeExtension[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(
    extensions.splice(0).map((extension) => extension.shutdown("quit"))
  );
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const deferred = () => {
  let finish: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  if (finish === undefined) throw new Error("missing resolver");
  releases.push(finish);
  return { promise, resolve: finish };
};
const ids = async (extension: FakeExtension, session: FakeSession) => {
  const result = await extension.tool(
    "list",
    { action: "list" },
    new AbortController().signal,
    undefined,
    session.context().ctx
  );
  if (result.details === undefined || !("watches" in result.details))
    throw new Error("missing list");
  return result.details.watches.map((watch) => watch.id);
};
const setup = async () => {
  const directory = mkdtempSync(join(tmpdir(), "until-settlement-"));
  directories.push(directory);
  const parent = new FakeSession();
  const first = loadExtension(parent, { handoff: { directory } });
  extensions.push(first);
  const receipt = receiptOf(
    await first.tool(
      "repeat",
      {
        action: "repeat",
        intervalSeconds: 300,
        timeoutSeconds: 3600,
        instruction: "Inspect inert fixtures",
        quickRef: "fixture",
      },
      new AbortController().signal,
      undefined,
      parent.context().ctx
    )
  );
  const successor = parent.fork();
  await first.shutdown("quit");
  const next = loadExtension(successor, {
    handoff: { directory, predecessorId: parent.id, successorId: successor.id },
  });
  extensions.push(next);
  return { directory, parent, successor, next, receipt };
};

it.each([
  "before rename",
  "after rename",
  "before rename with journal failure",
] as const)(
  "forwards an interrupted claim %s to a third successor",
  async (phase) => {
    const { directory, parent, successor, next, receipt } = await setup();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const entered = deferred();
    const release = deferred();
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source) !== join(directory, `${parent.id}.json`))
        return actual.rename(source, target);
      if (phase === "after rename") await actual.rename(source, target);
      entered.resolve();
      await release.promise;
      if (phase !== "after rename") await actual.rename(source, target);
    });
    const beforeExit = new Set(process.listeners("exit"));
    await next.sessionStart("startup", successor.context().ctx);
    await entered.promise;
    let stopping: Promise<void>;
    if (phase === "after rename") {
      // Only the file exists: the async claim result has not reached adoptLink.
      expect(
        handoff.claimedHandoffSync(directory, parent.id, successor.id)
      ).toMatchObject({
        suspension: { watches: [{ facts: { id: receipt.id } }] },
      });
      const hook = process
        .listeners("exit")
        .find((listener) => !beforeExit.has(listener));
      expect(hook).toBeDefined();
      hook?.(129);
      expect(
        newestSuspension(successor.entries)?.watches.map(
          (watch) => watch.facts.id
        )
      ).toEqual([receipt.id]);
      stopping = next.shutdown("quit");
    } else {
      stopping = next.shutdown("quit");
      expect(newestSuspension(successor.entries)?.watches).toEqual([]);
      expect(existsSync(join(directory, `${successor.id}.json`))).toBe(false);
    }
    if (phase === "before rename with journal failure") {
      const append = next.appendEntry.getMockImplementation();
      if (append === undefined)
        throw new Error("missing append implementation");
      let fail = true;
      next.appendEntry.mockImplementation((type, data) => {
        if (type === SUSPENDED_ENTRY_TYPE && fail) {
          fail = false;
          throw new Error("corrective journal unavailable");
        }
        append(type, data);
      });
      release.resolve();
      await expect(stopping).rejects.toThrow("corrective journal unavailable");
      const hook = process
        .listeners("exit")
        .find((listener) => !beforeExit.has(listener));
      expect(hook).toBeDefined();
      hook?.(129);
    } else {
      release.resolve();
      await stopping;
    }
    expect(
      newestSuspension(successor.entries)?.watches.map(
        (watch) => watch.facts.id
      )
    ).toEqual([receipt.id]);
    expect(
      next.entries.filter((entry) => entry.customType === SUSPENDED_ENTRY_TYPE)
    ).toHaveLength(phase === "after rename" ? 1 : 2);
    const third = successor.fork();
    const last = loadExtension(third, {
      handoff: {
        directory,
        predecessorId: successor.id,
        successorId: third.id,
      },
    });
    extensions.push(last);
    await last.sessionStart("startup", third.context().ctx);
    await vi.waitFor(async () =>
      expect(await ids(last, third)).toEqual([receipt.id])
    );
  }
);

it.each(["claim", "receipt"] as const)(
  "does not re-suspend a pending restoration transferred by %s",
  async (evidence) => {
    const { directory, parent, successor, next, receipt } = await setup();
    const originalPayload = readFileSync(
      join(directory, `${parent.id}.json`),
      "utf-8"
    );
    await next.sessionStart("startup", successor.context().ctx);
    await vi.waitFor(() =>
      expect(
        existsSync(
          join(directory, "receipts", `${parent.id}!${successor.id}.json`)
        )
      ).toBe(true)
    );
    expect(await ids(next, successor)).toEqual([receipt.id]);
    if (evidence === "claim") {
      await fs.writeFile(
        join(directory, "claimed", `${parent.id}!${successor.id}.json`),
        originalPayload,
        { mode: 0o600 }
      );
      await fs.unlink(
        join(directory, "receipts", `${parent.id}!${successor.id}.json`)
      );
    }
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const entered = deferred();
    const release = deferred();
    vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (String(source) === join(directory, `${parent.id}.json`)) {
        entered.resolve();
        await release.promise;
      }
      return actual.rename(source, target);
    });
    const reopening = loadExtension(parent, { handoff: { directory } });
    extensions.push(reopening);
    const starting = reopening.sessionStart("startup", parent.context().ctx);
    await entered.promise;
    const stopping = reopening.shutdown("quit");
    expect(newestSuspension(parent.entries)?.watches).toEqual([]);
    release.resolve();
    await Promise.all([starting, stopping]);
    const again = loadExtension(parent, { handoff: { directory } });
    extensions.push(again);
    await again.sessionStart("startup", parent.context().ctx);
    expect(await ids(again, parent)).toEqual([]);
    expect(await ids(next, successor)).toEqual([receipt.id]);
  }
);

it.each(["before rename", "after rename"] as const)(
  "never changes a transfer id after publication failure %s",
  async (phase) => {
    const { directory, parent } = await setup();
    const session = new FakeSession();
    const extension = loadExtension(session, { handoff: { directory } });
    extensions.push(extension);
    const before = new Set(process.listeners("exit"));
    await extension.sessionStart("startup", session.context().ctx);
    await extension.tool(
      "repeat",
      {
        action: "repeat",
        intervalSeconds: 300,
        timeoutSeconds: 3600,
        instruction: "Inert",
        quickRef: "fixture",
      },
      new AbortController().signal,
      undefined,
      session.context().ctx
    );
    const hook = process
      .listeners("exit")
      .find((listener) => !before.has(listener));
    expect(hook).toBeDefined();
    const actual = await vi.importActual<typeof handoff>("../src/handoff.ts");
    const attempts: handoff.HandoffPayload[] = [];
    vi.mocked(handoff.publishHandoffSync).mockImplementation(
      (folder, payload, options) => {
        attempts.push(payload);
        if (attempts.length === 1) {
          const error = Object.assign(
            new Error("private details must not be logged"),
            { code: "EIO" }
          );
          if (phase === "before rename") throw error;
          return actual.publishHandoffSync(folder, payload, {
            ...options,
            syncDirectory: () => {
              throw error;
            },
          });
        }
        return actual.publishHandoffSync(folder, payload, options);
      }
    );
    hook?.(129);
    hook?.(129);
    const path = join(directory, `${session.id}.json`);
    const payload = JSON.parse(readFileSync(path, "utf-8"));
    expect(payload.transferId).toBeDefined();
    expect(attempts).toHaveLength(phase === "before rename" ? 2 : 1);
    if (phase === "before rename") expect(attempts[0]).toBe(attempts[1]);
    const claimed = await handoff.claimHandoff({
      directory,
      predecessorId: session.id,
      successorId: parent.id,
      signal: new AbortController().signal,
    });
    expect(claimed).toMatchObject({
      kind: "claimed",
      handoff: { transferId: payload.transferId },
    });
    await extension.shutdown("quit");
    expect(existsSync(path)).toBe(false);
    const log = join(directory, "persistence-errors.jsonl");
    expect(readFileSync(log, "utf-8")).toContain('"code":"EIO"');
    expect(readFileSync(log, "utf-8")).not.toContain("private details");
    expect(statSync(log).mode % 0o1000).toBe(0o600);
  }
);
