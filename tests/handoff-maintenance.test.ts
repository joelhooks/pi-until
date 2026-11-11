import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initialFacts,
  watchDefinitionSchema,
  watchFactsSchema,
} from "../src/domain.ts";
import type { WatchDefinition } from "../src/domain.ts";
import {
  claimHandoff,
  completeHandoff,
  consumeOwnHandoff,
  forkPointFrom,
  handoffOptionsFromEnv,
  pruneHandoffs,
  publishHandoff,
  PERSISTENCE_ERRORS_FILE,
} from "../src/handoff.ts";
import { suspensionData, newestSuspension } from "../src/suspension.ts";
import { FakeSession, loadExtension } from "./fake-pi.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
const directoryFor = async () => {
  const path = await mkdtemp(join(tmpdir(), "until-retention-"));
  directories.push(path);
  return path;
};
it.each(["fresh", "old", "oversize"] as const)(
  "bounds the private persistence error log: %s",
  async (kind) => {
    const directory = await directoryFor();
    const file = join(directory, PERSISTENCE_ERRORS_FILE);
    await writeFile(
      file,
      kind === "oversize" ? Buffer.alloc(65 * 1024) : '{"code":"EIO"}\n',
      { mode: 0o600 }
    );
    await writeFile(join(directory, "unrelated.jsonl"), "keep");
    if (kind === "old") await utimes(file, new Date(0), new Date(0));
    await pruneHandoffs({ directory, now: Date.now(), retentionMs: 1_000 });
    const files = await readdir(directory);
    expect(files.includes(PERSISTENCE_ERRORS_FILE)).toBe(kind === "fresh");
    expect(await readFile(join(directory, "unrelated.jsonl"), "utf-8")).toBe(
      "keep"
    );
  }
);

const definition: WatchDefinition = {
  kind: "until",
  intervalMs: 60_000,
  label: "inert",
  gate: { command: "false", cwd: tmpdir(), checkTimeoutMs: 1000 },
  wake: "agent",
};
const pending = (id = "parent", expiresAt?: number) =>
  suspensionData(
    [
      {
        definition: {
          ...definition,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
        facts: initialFacts(definition, "watch", Date.now()),
      },
    ],
    Date.now(),
    "quit",
    id
  );

// The v3 boundary from 1d7b250 (before handoff): exact property set and strict
// additionalProperties. Previous newestSuspension uses this Value.Check before
// reading watches and treats an invalid newest entry as empty.
const previousV3Schema = Type.Object(
  {
    reason: Type.Union([Type.Literal("reload"), Type.Literal("quit")]),
    sessionId: Type.String(),
    suspendedAt: Type.String(),
    v: Type.Literal(3),
    watches: Type.Array(
      Type.Object(
        { definition: watchDefinitionSchema, facts: watchFactsSchema },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

describe("handoff storage and configuration", () => {
  it("uses the copied quit time, not later child-startup metadata, as the fork floor", () => {
    const session = new FakeSession("2026-11-06T12:00:02.000Z");
    session.appendCustom(
      "pi-until-suspended",
      suspensionData(
        [],
        Date.parse("2026-11-06T12:00:00.000Z"),
        "quit",
        "parent"
      ),
      "2026-11-06T12:00:00.500Z"
    );
    session.appendCustom(
      "other-extension-startup",
      {},
      "2026-11-06T12:00:03.000Z"
    );
    expect(forkPointFrom(session.entries, session.createdAt)).toBe(
      "2026-11-06T12:00:00.000Z"
    );
  });
  it("stops polling after the deadline but adopts through the passive filesystem watcher", async () => {
    const directory = await directoryFor();
    const controller = new AbortController();
    const interval = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const timeout = vi.fn();
    try {
      const pendingClaim = claimHandoff({
        directory,
        predecessorId: "parent",
        successorId: "child",
        signal: controller.signal,
        waitMs: 10,
        passive: true,
        onTimeout: (watching) => {
          timeout(watching);
        },
      });
      await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(true));
      const poll = interval.mock.results.find(
        (result) => result.type === "return"
      )?.value;
      expect(poll).toBeDefined();
      expect(cleared).toHaveBeenCalledWith(poll);
      await publishHandoff(directory, pending());
      expect(await pendingClaim).toMatchObject({ kind: "claimed" });
    } finally {
      controller.abort();
      interval.mockRestore();
      cleared.mockRestore();
    }
  });
  it("consumes declaration-only env once while preserving Rat King env", () => {
    const env = {
      PI_UNTIL_SUCCEEDS: "parent",
      PI_UNTIL_SUCCESSOR_ID: "child",
      RATKING_SUCCEEDS: "rat-parent",
      PI_SESSION_ID: "bash-parent",
      PI_UNTIL_HANDOFF_RECEIPT_RETENTION_MS: "1000",
    };
    expect(handoffOptionsFromEnv(env)).toMatchObject({
      predecessorId: "parent",
      successorId: "child",
      receiptRetentionMs: 1000,
    });
    expect(env).not.toHaveProperty("PI_UNTIL_SUCCEEDS");
    expect(env).not.toHaveProperty("PI_UNTIL_SUCCESSOR_ID");
    expect(env.RATKING_SUCCEEDS).toBe("rat-parent");
  });
  it("reads the renamed claim after directory fsync fails", async () => {
    const directory = await directoryFor();
    await publishHandoff(directory, pending());
    const warnings: string[] = [];
    const result = await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: new AbortController().signal,
      sync: async () => {
        throw new Error("injected filesystem fault");
      },
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(result.kind).toBe("claimed");
    expect(warnings).toHaveLength(1);
  });
  it("keeps dotted id pairs in distinct claim files", async () => {
    const directory = await directoryFor();
    await Promise.all([
      publishHandoff(directory, pending("a.b")),
      publishHandoff(directory, pending("a")),
    ]);
    const results = await Promise.all(
      [
        { predecessorId: "a.b", successorId: "c" },
        { predecessorId: "a", successorId: "b.c" },
      ].map((ids) =>
        claimHandoff({
          directory,
          ...ids,
          signal: new AbortController().signal,
        })
      )
    );
    expect(results.map((result) => result.kind)).toEqual([
      "claimed",
      "claimed",
    ]);
    expect(await readdir(join(directory, "claimed"))).toEqual([
      "a!b.c.json",
      "a.b!c.json",
    ]);
  });
  it("does not write terminal requests into reload entries", () => {
    expect(
      suspensionData([], Date.now(), "reload", "parent", [
        {
          kind: "terminal",
          id: "wake",
          watchId: "done",
          dedupeKey: "terminal:done:succeeded",
          customType: "pi-until",
          content: "inert",
          details: {},
        },
      ])
    ).not.toHaveProperty("terminalFollowUps");
  });
  it.each([false, true])(
    "recovers this session's interrupted own claim (legacy: %s)",
    async (legacy) => {
      const directory = await directoryFor();
      const data = pending();
      await publishHandoff(directory, data);
      const owner = {
        directory,
        sessionId: "parent",
        suspendedAt: data.suspendedAt,
      };
      expect(await consumeOwnHandoff(owner)).toBe(true);
      if (legacy)
        await rename(
          join(directory, "claimed", "parent!parent.json"),
          join(directory, "claimed", "parent.parent.json")
        );
      expect(await consumeOwnHandoff(owner)).toBe(true);
    }
  );
  it("refuses an own reopen while a successor's claim becomes a receipt between listings", async () => {
    const directory = await directoryFor();
    const data = pending();
    await publishHandoff(directory, data);
    const claimed = await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: new AbortController().signal,
    });
    if (claimed.kind !== "claimed") throw new Error("missing claim");
    let completed = false;
    const order: string[] = [];
    const own = await consumeOwnHandoff({
      directory,
      sessionId: "parent",
      suspendedAt: data.suspendedAt,
      list: async (path) => {
        if (path === join(directory, "claimed")) {
          order.push("claimed");
          await completeHandoff({
            directory,
            predecessorId: "parent",
            successorId: "child",
            handoff: claimed.handoff,
          });
          completed = true;
          order.push("completed");
          return readdir(path);
        }
        order.push("receipts");
        return completed ? readdir(path) : [];
      },
    });
    expect(own).toBe(false);
    expect(order).toEqual(["claimed", "completed", "receipts"]);
  });
  it("ignores foreign shutdown metadata and a distiller-stamped summary before the child header", () => {
    const session = new FakeSession("2026-11-06T12:01:00.000Z");
    session.appendCustom(
      "pi-until-suspended",
      suspensionData(
        [],
        Date.parse("2026-11-06T12:00:00.000Z"),
        "quit",
        "parent"
      ),
      "2026-11-06T12:00:00.500Z"
    );
    session.appendCustom("foreign-shutdown", {}, "2026-11-06T12:00:10.000Z");
    session.entries.push({
      type: "compaction",
      id: "summary",
      parentId: "e2",
      timestamp: "2026-11-06T12:00:20.000Z",
      summary: "Isolated distiller fixture",
      firstKeptEntryId: "e1",
      tokensBefore: 1,
    });
    expect(forkPointFrom(session.entries, session.createdAt)).toBe(
      "2026-11-06T12:00:00.000Z"
    );
  });
  it("checks valid receipts before transcript fallback after a rename error", async () => {
    const directory = await directoryFor();
    const data = pending();
    await publishHandoff(directory, data);
    const result = await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: new AbortController().signal,
    });
    if (result.kind !== "claimed") throw new Error("missing claim");
    await completeHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      handoff: result.handoff,
    });
    // A non-empty target directory makes file rename fail, while the valid
    // other-owner receipt must still defeat transcript fallback.
    await publishHandoff(directory, data);
    await mkdir(join(directory, "claimed", "parent!parent.json"));
    await writeFile(
      join(directory, "claimed", "parent!parent.json", "keep"),
      "inert"
    );
    await writeFile(
      join(directory, "receipts", "parent.broken.json"),
      "not JSON"
    );
    const owner = {
      directory,
      sessionId: "parent",
      suspendedAt: data.suspendedAt,
    };
    expect(await consumeOwnHandoff(owner)).toBe(false);
    await rm(join(directory, "receipts", "parent!child.json"));
    expect(await consumeOwnHandoff(owner)).toBe(true);
  });
  it("skips corrupt files without allowing duplicate ownership", async () => {
    const directory = await directoryFor();
    const data = pending();
    await publishHandoff(directory, data);
    await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: new AbortController().signal,
    });
    await writeFile(
      join(directory, "claimed", "parent.broken.json"),
      "not JSON"
    );
    const warnings: string[] = [];
    expect(
      await consumeOwnHandoff({
        directory,
        sessionId: "parent",
        suspendedAt: data.suspendedAt,
        warn: (message) => {
          warnings.push(message);
        },
      })
    ).toBe(false);
    expect(warnings).toHaveLength(1);
  });
  it("resumes a legacy quit with no mailbox and skips corrupt unrelated claims", async () => {
    const directory = await directoryFor();
    expect(await consumeOwnHandoff({ directory, sessionId: "legacy" })).toBe(
      true
    );
    await writeFile(
      join(directory, "claimed", "legacy.broken.json"),
      "not JSON"
    );
    expect(await consumeOwnHandoff({ directory, sessionId: "legacy" })).toBe(
      true
    );
  });
  it("expires indefinite receipts after 180 days and tmp payloads after one day", async () => {
    const directory = await directoryFor();
    const now = Date.now();
    await mkdir(join(directory, "receipts"));
    await writeFile(join(directory, ".old.tmp"), "private");
    await writeFile(join(directory, ".new.tmp"), "private");
    const path = join(directory, "receipts", "parent!child.json");
    await writeFile(
      path,
      JSON.stringify({
        predecessorId: "parent",
        successorId: "child",
        transferId: "t",
        suspendedAt: "s",
        latestExpiresAt: null,
      })
    );
    await utimes(path, new Date(0), new Date(0));
    await utimes(join(directory, ".old.tmp"), new Date(0), new Date(0));
    await pruneHandoffs({ directory, now });
    expect(await readdir(join(directory, "receipts"))).toEqual([]);
    expect(await readdir(directory)).not.toContain(".old.tmp");
    expect(await readdir(directory)).toContain(".new.tmp");
  });
  it("prunes receipts only after the latest guarded expiry, keeping indefinite receipts", async () => {
    const directory = await directoryFor();
    const now = Date.now();
    await Promise.all(
      [
        { id: "past", expiry: now - 1000 },
        { id: "future", expiry: now + 60_000 },
        { id: "indefinite", expiry: undefined },
      ].map(async ({ id, expiry }) => {
        const data = pending(id, expiry);
        await publishHandoff(directory, data);
        const result = await claimHandoff({
          directory,
          predecessorId: id,
          successorId: "child",
          signal: new AbortController().signal,
          waitMs: 30,
        });
        if (result.kind !== "claimed") throw new Error("missing claim");
        await completeHandoff({
          directory,
          predecessorId: id,
          successorId: "child",
          handoff: result.handoff,
        });
      })
    );
    await pruneHandoffs({ directory, now, retentionMs: 1000 });
    expect(await readdir(join(directory, "receipts"))).toEqual(
      expect.arrayContaining(["future!child.json", "indefinite!child.json"])
    );
    expect(await readdir(join(directory, "receipts"))).not.toContain(
      "past!child.json"
    );
  });
  it("keeps a quit with pending wakes readable by the previous v3 parser", async () => {
    const directory = await directoryFor();
    const session = new FakeSession();
    const extension = loadExtension(session, { handoff: { directory } });
    const busy = session.context({ idle: false }).ctx;
    try {
      await extension.tool(
        "active",
        { action: "start", condition: "false", intervalSeconds: 60 },
        new AbortController().signal,
        undefined,
        busy
      );
      await extension.tool(
        "done",
        { action: "start", condition: "true" },
        new AbortController().signal,
        undefined,
        busy
      );
      await vi.waitFor(() =>
        expect(
          session.entries.some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "pi-until-finished"
          )
        ).toBe(true)
      );
      await extension.shutdown("quit", busy);
      const record = newestSuspension(session.entries);
      const core = session.entries.find(
        (entry) => entry.id === record?.entryId
      );
      if (core?.type !== "custom") throw new Error("missing quit core");
      expect(Value.Check(previousV3Schema, core.data)).toBe(true);
      if (!Value.Check(previousV3Schema, core.data))
        throw new Error("old parser rejected quit");
      expect(core.data.watches).toHaveLength(1);
      expect(core.data).not.toHaveProperty("terminalFollowUps");
      expect(record?.terminalFollowUps).toHaveLength(1);
    } finally {
      await extension.shutdown("new");
    }
  });
  it("keeps no-follow-up suspension entries readable by the previous v3 boundary", () => {
    const data = pending();
    expect(data).not.toHaveProperty("terminalFollowUps");
    expect(Value.Check(previousV3Schema, data)).toBe(true);
    if (!Value.Check(previousV3Schema, data))
      throw new Error("previous parser rejected new entry");
    expect(data.watches[0]?.facts.id).toBe("watch");
  });
  it("uses a 30-minute default, configurable wait and retention, and empty-env fallback", () => {
    expect(handoffOptionsFromEnv({})).toMatchObject({
      waitMs: 1_800_000,
      retentionMs: 604_800_000,
    });
    expect(
      handoffOptionsFromEnv({
        PI_UNTIL_SUCCEEDS: "",
        RATKING_SUCCEEDS: "parent",
        PI_UNTIL_HANDOFF_WAIT_MS: "300000",
        PI_UNTIL_HANDOFF_RETENTION_MS: "86400000",
      })
    ).toMatchObject({
      predecessorId: "parent",
      waitMs: 300_000,
      retentionMs: 86_400_000,
    });
  });
  it("publishes an empty tombstone that ends the successor wait immediately", async () => {
    const directory = await directoryFor();
    await publishHandoff(
      directory,
      suspensionData([], Date.now(), "quit", "empty")
    );
    const tombstone = JSON.parse(
      await readFile(join(directory, "empty.json"), "utf-8")
    );
    expect(tombstone).not.toHaveProperty("suspension");
    const result = await claimHandoff({
      directory,
      predecessorId: "empty",
      successorId: "child",
      signal: new AbortController().signal,
      waitMs: 1000,
    });
    expect(result.kind).toBe("nothing");
  });
  it("prunes only expired unclaimed payloads, not recent or claimed work", async () => {
    const directory = await directoryFor();
    const now = Date.now();
    await publishHandoff(directory, pending("old"));
    await publishHandoff(directory, pending("new"));
    await mkdir(join(directory, "claimed"), { recursive: true });
    await writeFile(
      join(directory, "claimed", "keep.json"),
      "private pending claim"
    );
    await writeFile(join(directory, "notes.txt"), "not a mailbox");
    await utimes(
      join(directory, "old.json"),
      new Date(now - 2000),
      new Date(now - 2000)
    );
    await pruneHandoffs({ directory, now, retentionMs: 1000 });
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(["new.json", "claimed", "notes.txt"])
    );
    expect(await readdir(directory)).not.toContain("old.json");
    expect(
      await readFile(join(directory, "claimed", "keep.json"), "utf-8")
    ).toBe("private pending claim");
  });
  it("uses private file permissions and deletes the payload after a journalled claim", async () => {
    const directory = await directoryFor();
    await publishHandoff(directory, pending());
    const metadata = await stat(join(directory, "parent.json"));
    expect(metadata.mode % 0o1000).toBe(0o600);
    const result = await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: new AbortController().signal,
      waitMs: 30,
    });
    if (result.kind !== "claimed") throw new Error("missing claim");
    const owner = {
      directory,
      sessionId: "parent",
      suspendedAt: result.handoff.suspension.suspendedAt,
    };
    await expect(consumeOwnHandoff(owner)).resolves.toBe(false);
    await completeHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      handoff: result.handoff,
    });
    expect(await readdir(join(directory, "claimed"))).not.toContain(
      "parent!child.json"
    );
    await expect(consumeOwnHandoff(owner)).resolves.toBe(false);
    const receipt = JSON.parse(
      await readFile(join(directory, "receipts", "parent!child.json"), "utf-8")
    );
    expect(receipt).toMatchObject({
      predecessorId: "parent",
      successorId: "child",
      latestExpiresAt: null,
    });
    expect(receipt).not.toHaveProperty("suspension");
  });
});
