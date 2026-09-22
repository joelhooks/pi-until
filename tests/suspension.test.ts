import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { initialFacts } from "../src/domain.ts";
import type {
  RecurringDefinition,
  UntilDefinition,
  WatchContext,
} from "../src/domain.ts";
import {
  RESUMED_ENTRY_TYPE,
  SUSPENDED_ENTRY_TYPE,
  SUSPENSION_VERSION,
  partitionResumable,
  quitSuspensionFor,
  resumeInput,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
  unfinishedWatches,
} from "../src/suspension.ts";

const untilDefinition: UntilDefinition = {
  expiresAt: 61_000,
  gate: {
    checkTimeoutMs: 1_000,
    command: "test -f ready",
    cwd: "/tmp",
  },
  intervalMs: 500,
  kind: "until",
  label: "ready",
  wake: "agent",
};

const recurringDefinition: RecurringDefinition = {
  expiresAt: 100_000,
  first: "afterInterval",
  intervalMs: 10_000,
  kind: "recurring",
  label: "follow up",
  snapshot: {
    capturedAt: 1_000,
    contextRefs: [{ label: "Runbook", target: "docs/runbook.md" }],
    instruction: "Inspect the deployment.",
    origin: { entryId: "e1", sessionId: "s1" },
    quickRef: "release verification",
  },
};

const context = (
  definition: UntilDefinition | RecurringDefinition
): WatchContext => ({
  definition,
  facts: {
    ...initialFacts(definition, "abc12345", 1_000),
    attempts: 7,
    deliveries: definition.kind === "recurring" ? 2 : 0,
    reloads: 1,
  },
});

const custom = (
  customType: string,
  data: CustomEntry["data"],
  timestamp = "2026-01-01T00:00:00.000Z"
): SessionEntry => ({
  customType,
  data,
  id: "x",
  parentId: null,
  timestamp,
  type: "custom",
});

const userMessage: SessionEntry = {
  id: "m",
  message: { content: "later", role: "user", timestamp: 0 },
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  type: "message",
};

const owner = {
  sessionCreatedAt: "2025-12-31T00:00:00.000Z",
  sessionId: "s1",
};

describe("suspension", () => {
  it("partitions suspended watches by absolute expiry for an explicit resume", () => {
    const until = suspendWatch(context(untilDefinition));
    const recurring = suspendWatch(context(recurringDefinition));
    const open: RecurringDefinition = { ...recurringDefinition };
    delete (open as { expiresAt?: number }).expiresAt;
    const unbounded = suspendWatch(context(open));

    expect(partitionResumable([until, recurring, unbounded], 60_000)).toEqual({
      expired: [],
      resumable: [until, recurring, unbounded],
    });
    expect(partitionResumable([until, recurring, unbounded], 61_000)).toEqual({
      expired: [until],
      resumable: [recurring, unbounded],
    });
    expect(partitionResumable([until, recurring, unbounded], 500_000)).toEqual({
      expired: [until, recurring],
      resumable: [unbounded],
    });
  });

  it("round-trips normalized watch values and increments reload history", () => {
    const persisted = suspendWatch(context(recurringDefinition));
    expect(persisted).toMatchObject({
      definition: recurringDefinition,
      facts: { attempts: 7, deliveries: 2, reloads: 2 },
    });
    expect(resumeInput(persisted)).toEqual({
      definition: recurringDefinition,
      facts: persisted.facts,
    });
  });

  it("takes only the newest versioned suspension entry on the branch", () => {
    const older = suspensionData(
      [suspendWatch(context(untilDefinition))],
      5_000,
      "reload",
      "s1"
    );
    const newer = suspensionData([], 6_000, "quit", "s1");
    expect(newer.v).toBe(SUSPENSION_VERSION);
    expect(
      suspendedWatchesFrom([
        custom(SUSPENDED_ENTRY_TYPE, older),
        custom("other", { watches: [{ id: "nope" }] }),
        custom(SUSPENDED_ENTRY_TYPE, newer),
      ])
    ).toEqual([]);
    expect(
      suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, older)])
    ).toHaveLength(1);
  });

  it("rejects malformed newest data instead of trusting older facts", () => {
    const valid = suspensionData(
      [suspendWatch(context(untilDefinition))],
      5_000,
      "reload",
      "s1"
    );
    expect(
      suspendedWatchesFrom([
        custom(SUSPENDED_ENTRY_TYPE, valid),
        custom(SUSPENDED_ENTRY_TYPE, { v: 2, watches: [{ id: 1 }] }),
      ])
    ).toEqual([]);
    expect(suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, null)])).toEqual(
      []
    );
    expect(suspendedWatchesFrom([])).toEqual([]);
  });

  it("normalizes legacy reload entries without extending their deadline", () => {
    const [watch] = suspendedWatchesFrom([
      custom(SUSPENDED_ENTRY_TYPE, {
        suspendedAt: "1970-01-01T00:00:05.000Z",
        watches: [
          {
            attempts: 4,
            checkTimeoutMs: 1_000,
            command: "test -f ready",
            cwd: "/tmp",
            id: "legacy",
            intervalMs: 500,
            label: "legacy",
            reloads: 2,
            startedAt: 1_000,
            timeoutMs: 60_000,
            wake: "agent",
          },
        ],
      }),
    ]);

    expect(watch).toMatchObject({
      definition: {
        expiresAt: 61_000,
        gate: { command: "test -f ready" },
        kind: "until",
      },
      facts: {
        attempts: 4,
        id: "legacy",
        nextDueAt: 5_000,
        reloads: 2,
        startedAt: 1_000,
      },
    });
  });

  describe("quit hand-off", () => {
    const watch = suspendWatch(context(untilDefinition));
    const quit = custom(
      SUSPENDED_ENTRY_TYPE,
      suspensionData([watch], 5_000, "quit", "s1")
    );

    it("hands a quit entry to the next process of the same session", () => {
      expect(quitSuspensionFor([quit], owner)?.watches).toEqual([watch]);
      expect(quitSuspensionFor([quit, userMessage], owner)).toBeDefined();
    });

    it("refuses reload entries, other sessions, empty entries, and consumed entries", () => {
      const reload = custom(
        SUSPENDED_ENTRY_TYPE,
        suspensionData([watch], 5_000, "reload", "s1")
      );
      const empty = custom(
        SUSPENDED_ENTRY_TYPE,
        suspensionData([], 5_000, "quit", "s1")
      );
      const consumed = custom(RESUMED_ENTRY_TYPE, {
        from: "x",
        resumed: 1,
        resumedAt: "2026-01-01T00:00:02.000Z",
        skippedExpired: 0,
      });
      expect(quitSuspensionFor([reload], owner)).toBeUndefined();
      expect(
        quitSuspensionFor([quit], { ...owner, sessionId: "fork" })
      ).toBeUndefined();
      expect(quitSuspensionFor([quit, empty], owner)).toBeUndefined();
      expect(quitSuspensionFor([quit, consumed], owner)).toBeUndefined();
      expect(quitSuspensionFor([], owner)).toBeUndefined();
    });

    it("treats an unattributed version 2 entry as a quit only at the tail of this session", () => {
      const v2 = custom(SUSPENDED_ENTRY_TYPE, {
        suspendedAt: "2026-01-01T00:00:00.000Z",
        v: 2,
        watches: [watch],
      });
      expect(quitSuspensionFor([v2], owner)?.watches).toEqual([watch]);
      expect(quitSuspensionFor([v2, userMessage], owner)).toBeUndefined();
      expect(
        quitSuspensionFor([v2], {
          ...owner,
          sessionCreatedAt: "2026-02-01T00:00:00.000Z",
        })
      ).toBeUndefined();
      expect(quitSuspensionFor([v2], { sessionId: "s1" })).toBeUndefined();
    });

    it("drops finished and repeated watch ids from a suspension record", () => {
      const other = suspendWatch({
        ...context(untilDefinition),
        facts: { ...context(untilDefinition).facts, id: "other001" },
      });
      const entries = [
        custom(
          SUSPENDED_ENTRY_TYPE,
          suspensionData([watch, watch, other], 5_000, "quit", "s1")
        ),
        custom("pi-until-finished", { id: "other001", status: "succeeded" }),
      ];
      const record = quitSuspensionFor(entries, owner);
      if (record === undefined) throw new Error("expected a quit record");
      expect(unfinishedWatches(record, entries)).toEqual([watch]);
    });
  });
});
