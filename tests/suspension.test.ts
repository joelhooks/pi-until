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
  SUSPENDED_ENTRY_TYPE,
  SUSPENSION_VERSION,
  resumeInput,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
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
  data: CustomEntry["data"]
): SessionEntry => ({
  customType,
  data,
  id: "x",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "custom",
});

describe("suspension", () => {
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
      5_000
    );
    const newer = suspensionData([], 6_000);
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
      5_000
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
});
