import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { UntilInput } from "../src/machine.ts";
import {
  SUSPENDED_ENTRY_TYPE,
  remainingTimeoutMs,
  resumeInput,
  suspendWatch,
  suspendedWatchesFrom,
  suspensionData,
} from "../src/suspension.ts";

const input: UntilInput = {
  checkTimeoutMs: 1_000,
  command: "test -f ready",
  cwd: "/tmp",
  id: "abc12345",
  intervalMs: 500,
  label: "ready",
  startedAt: 1_000,
  wake: "agent",
};

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
  it("round-trips a watch through suspend and resume with history", () => {
    const suspended = suspendWatch(
      { ...input, timeoutMs: 60_000 },
      { attempts: 3, reloads: 1 },
      4
    );
    expect(suspended).toMatchObject({
      attempts: 7,
      reloads: 2,
      timeoutMs: 60_000,
    });
    expect(resumeInput(suspended)).toEqual({ ...input, timeoutMs: 60_000 });
    expect(
      resumeInput(suspendWatch(input, { attempts: 0, reloads: 0 }, 0))
    ).toEqual(input);
    expect(
      "timeoutMs" in
        resumeInput(suspendWatch(input, { attempts: 0, reloads: 0 }, 0))
    ).toBe(false);
  });

  it("takes only the newest suspension entry on the branch", () => {
    const older = suspensionData(
      [suspendWatch(input, { attempts: 0, reloads: 0 }, 1)],
      5_000
    );
    const newer = suspensionData([], 6_000);
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

  it("rejects malformed suspension data instead of trusting it", () => {
    expect(
      suspendedWatchesFrom([
        custom(SUSPENDED_ENTRY_TYPE, { watches: [{ id: 1, command: "x" }] }),
      ])
    ).toEqual([]);
    expect(suspendedWatchesFrom([custom(SUSPENDED_ENTRY_TYPE, null)])).toEqual(
      []
    );
    expect(suspendedWatchesFrom([])).toEqual([]);
  });

  it("measures the remaining timeout from the original start", () => {
    expect(
      remainingTimeoutMs({ startedAt: 1_000, timeoutMs: 5_000 }, 3_000)
    ).toBe(3_000);
    expect(
      remainingTimeoutMs({ startedAt: 1_000, timeoutMs: 5_000 }, 9_000)
    ).toBe(0);
    expect(remainingTimeoutMs({ startedAt: 1_000 }, 9_000)).toBeUndefined();
  });
});
