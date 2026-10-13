import { describe, expect, it, vi } from "vitest";
import { createActor, SimulatedClock } from "xstate";

import {
  createFollowUpMachine,
  type FollowUpRequest,
} from "../src/follow-up.ts";

const request = (name: string): FollowUpRequest => ({
  dedupeKey: `watch:${name}`,
  id: `delivery:${name}`,
  kind: "recurring",
  watchId: name,
});

const terminal = (name: string): FollowUpRequest => ({
  content: `result ${name}`,
  customType: "pi-until",
  dedupeKey: `terminal:${name}`,
  details: {},
  id: `delivery:${name}`,
  kind: "terminal",
  watchId: name,
});

describe("session follow-up queue", () => {
  it("dispatches one follow-up at a time for the whole session", () => {
    const dispatch = vi.fn();
    const started = vi.fn();
    const settled = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        settled: (item) => {
          settled(item);
        },
        started: (item) => {
          started(item);
        },
      }),
      { input: { sessionBusy: true } }
    );
    actor.start();

    actor.send({ request: request("first"), type: "ENQUEUE" });
    actor.send({ request: request("second"), type: "ENQUEUE" });
    expect(dispatch).not.toHaveBeenCalled();

    actor.send({ type: "SESSION_SETTLED" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenLastCalledWith(request("first"));

    actor.send({ id: "delivery:first", type: "MESSAGE_STARTED" });
    expect(started).toHaveBeenCalledWith(request("first"));
    actor.send({ type: "SESSION_SETTLED" });

    expect(settled).toHaveBeenCalledWith(request("first"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith(request("second"));
  });

  it("deduplicates one pending tick per watch", () => {
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { input: { sessionBusy: true } }
    );
    actor.start();

    actor.send({ request: request("same"), type: "ENQUEUE" });
    actor.send({ request: request("same"), type: "ENQUEUE" });
    actor.send({ type: "SESSION_SETTLED" });
    actor.send({ id: "delivery:same", type: "MESSAGE_STARTED" });
    actor.send({ type: "SESSION_SETTLED" });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("pauses on an uncertain acknowledgement and reconciles a late start", () => {
    const clock = new SimulatedClock();
    const dispatch = vi.fn();
    const settled = vi.fn();
    const started = vi.fn();
    const unacknowledged = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        dispatchAckMs: 5_000,
        now: () => clock.now(),
        settled: (item) => {
          settled(item);
        },
        started: (item) => {
          started(item);
        },
        unacknowledged: (item) => {
          unacknowledged(item);
        },
      }),
      { clock, input: { sessionBusy: false } }
    );
    actor.start();
    actor.send({ request: request("first"), type: "ENQUEUE" });
    actor.send({ request: request("second"), type: "ENQUEUE" });

    expect(dispatch).toHaveBeenCalledTimes(1);
    clock.increment(5_000);

    expect(unacknowledged).toHaveBeenCalledWith({
      ...request("first"),
      dispatchedAt: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().matches("startUncertain")).toBe(true);

    actor.send({ id: "delivery:first", type: "MESSAGE_STARTED" });
    expect(started).toHaveBeenCalledWith({
      ...request("first"),
      dispatchedAt: 0,
    });
    actor.send({ type: "SESSION_SETTLED" });
    expect(settled).toHaveBeenCalledWith({
      ...request("first"),
      dispatchedAt: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith({
      ...request("second"),
      dispatchedAt: 5_000,
    });
  });

  it("fails a delayed rejection and continues with the next item", () => {
    const clock = new SimulatedClock();
    const dispatch = vi.fn();
    const failed = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        dispatchAckMs: 5_000,
        failed: (item) => {
          failed(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { clock, input: { sessionBusy: false } }
    );
    actor.start();
    actor.send({ request: request("first"), type: "ENQUEUE" });
    actor.send({ request: request("second"), type: "ENQUEUE" });
    clock.increment(5_000);
    expect(actor.getSnapshot().matches("startUncertain")).toBe(true);
    actor.send({ id: "delivery:first", type: "DISPATCH_FAILED" });

    expect(failed).toHaveBeenCalledWith(request("first"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith(request("second"));
  });

  it("holds dispatch while compaction runs and releases after a grace window", () => {
    const clock = new SimulatedClock();
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        compactionGraceMs: 2_000,
        dispatch: (item) => {
          dispatch(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { clock, input: { sessionBusy: false } }
    );
    actor.start();

    actor.send({ type: "COMPACTION_STARTED" });
    actor.send({ request: request("held"), type: "ENQUEUE" });
    clock.increment(60_000);
    expect(dispatch).not.toHaveBeenCalled();

    actor.send({ type: "COMPACTION_ENDED" });
    expect(dispatch).not.toHaveBeenCalled();
    clock.increment(1_999);
    expect(dispatch).not.toHaveBeenCalled();
    clock.increment(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(request("held"));
  });

  it("lets a prompt queued behind compaction start before a held wake", () => {
    const clock = new SimulatedClock();
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        compactionGraceMs: 2_000,
        dispatch: (item) => {
          dispatch(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { clock, input: { sessionBusy: false } }
    );
    actor.start();

    actor.send({ type: "COMPACTION_STARTED" });
    actor.send({ request: request("held"), type: "ENQUEUE" });
    actor.send({ type: "COMPACTION_ENDED" });
    actor.send({ type: "SESSION_BUSY" });
    clock.increment(10_000);
    expect(dispatch).not.toHaveBeenCalled();

    actor.send({ type: "SESSION_SETTLED" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("treats a settled session as the end of a compaction it missed", () => {
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { input: { sessionBusy: false } }
    );
    actor.start();

    actor.send({ type: "COMPACTION_STARTED" });
    actor.send({ request: request("held"), type: "ENQUEUE" });
    expect(dispatch).not.toHaveBeenCalled();

    actor.send({ type: "SESSION_SETTLED" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(actor.getSnapshot().context.compacting).toBe(false);
  });

  it("does not add a grace window after compaction inside an agent run", () => {
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        settled: () => {},
        started: () => {},
      }),
      { input: { sessionBusy: true } }
    );
    actor.start();

    actor.send({ request: request("queued"), type: "ENQUEUE" });
    actor.send({ type: "COMPACTION_STARTED" });
    actor.send({ type: "COMPACTION_ENDED" });
    expect(dispatch).not.toHaveBeenCalled();

    actor.send({ type: "SESSION_SETTLED" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("drops queued work whose owner is no longer live", () => {
    const dispatch = vi.fn();
    const actor = createActor(
      createFollowUpMachine({
        dispatch: (item) => {
          dispatch(item);
        },
        isLive: (item) => item.watchId !== "stale",
        settled: () => {},
        started: () => {},
      }),
      { input: { sessionBusy: true } }
    );
    actor.start();
    actor.send({ request: request("stale"), type: "ENQUEUE" });
    actor.send({ request: request("live"), type: "ENQUEUE" });
    actor.send({ type: "SESSION_SETTLED" });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(request("live"));
  });
});

const harness = (sessionBusy: boolean) => {
  const clock = new SimulatedClock();
  const calls = {
    dispatch: vi.fn(),
    failed: vi.fn(),
    lost: vi.fn(),
    settled: vi.fn(),
    skipped: vi.fn(),
    started: vi.fn(),
  };
  const actor = createActor(
    createFollowUpMachine({
      dispatch: (item) => {
        calls.dispatch(item);
      },
      dispatchAckMs: 5_000,
      failed: (item) => {
        calls.failed(item);
      },
      lost: (item, retrying) => {
        calls.lost(item.id, retrying);
      },
      settled: (item) => {
        calls.settled(item);
      },
      skipped: (item) => {
        calls.skipped(item);
      },
      started: (item) => {
        calls.started(item);
      },
      uncertainMaxMs: 120_000,
    }),
    { clock, input: { sessionBusy } }
  );
  actor.start();
  return { actor, calls, clock };
};
const dispatchedIds = (dispatch: ReturnType<typeof vi.fn>) =>
  dispatch.mock.calls.map(([item]) => (item as FollowUpRequest).id);

describe("a dispatch that never starts", () => {
  it("retries a wake dispatched into a compaction, and later wakes still arrive", () => {
    const { actor, calls, clock } = harness(false);
    actor.send({ request: request("first"), type: "ENQUEUE" });
    actor.send({ request: request("second"), type: "ENQUEUE" });
    expect(dispatchedIds(calls.dispatch)).toEqual(["delivery:first"]);

    // Pi compacts as the wake goes out, runs, and settles without starting it.
    actor.send({ type: "COMPACTION_STARTED" });
    clock.increment(5_000);
    expect(actor.getSnapshot().matches("startUncertain")).toBe(true);
    actor.send({ type: "SESSION_BUSY" });
    actor.send({ type: "COMPACTION_ENDED" });
    actor.send({ type: "SESSION_SETTLED" });

    expect(calls.lost).toHaveBeenCalledWith("delivery:first", true);
    expect(calls.failed).not.toHaveBeenCalled();
    expect(dispatchedIds(calls.dispatch)).toEqual([
      "delivery:first",
      "delivery:first",
    ]);

    actor.send({ id: "delivery:first", type: "MESSAGE_STARTED" });
    actor.send({ type: "SESSION_SETTLED" });
    expect(dispatchedIds(calls.dispatch)).toEqual([
      "delivery:first",
      "delivery:first",
      "delivery:second",
    ]);
    actor.send({ id: "delivery:second", type: "MESSAGE_STARTED" });
    actor.send({ type: "SESSION_SETTLED" });
    expect(calls.settled).toHaveBeenCalledTimes(2);
  });

  it("fails a one-shot wake lost twice loudly and moves on", () => {
    const { actor, calls, clock } = harness(false);
    actor.send({ request: terminal("first"), type: "ENQUEUE" });
    actor.send({ request: request("second"), type: "ENQUEUE" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      clock.increment(5_000);
      actor.send({ type: "SESSION_BUSY" });
      actor.send({ type: "SESSION_SETTLED" });
    }

    expect(calls.lost.mock.calls).toEqual([
      ["delivery:first", true],
      ["delivery:first", false],
    ]);
    expect(calls.failed).toHaveBeenCalledOnce();
    expect(calls.skipped).not.toHaveBeenCalled();
    expect(dispatchedIds(calls.dispatch)).toEqual([
      "delivery:first",
      "delivery:first",
      "delivery:second",
    ]);
  });

  it("skips a recurring tick lost twice instead of failing its watch", () => {
    const { actor, calls, clock } = harness(false);
    actor.send({ request: request("first"), type: "ENQUEUE" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      clock.increment(5_000);
      actor.send({ type: "SESSION_BUSY" });
      actor.send({ type: "SESSION_SETTLED" });
    }

    expect(calls.skipped).toHaveBeenCalledOnce();
    expect(calls.failed).not.toHaveBeenCalled();
    expect(actor.getSnapshot().matches("ready")).toBe(true);
  });

  it("treats an unacknowledged wake on an idle session as lost after the cap", () => {
    const { actor, calls, clock } = harness(false);
    actor.send({ request: request("first"), type: "ENQUEUE" });
    clock.increment(5_000);
    clock.increment(119_999);
    expect(calls.lost).not.toHaveBeenCalled();
    clock.increment(1);

    expect(calls.lost).toHaveBeenCalledWith("delivery:first", true);
    expect(dispatchedIds(calls.dispatch)).toEqual([
      "delivery:first",
      "delivery:first",
    ]);
  });

  it("keeps waiting while a run that may still start the wake is busy", () => {
    const { actor, calls, clock } = harness(false);
    actor.send({ request: request("first"), type: "ENQUEUE" });
    clock.increment(5_000);
    actor.send({ type: "SESSION_BUSY" });
    clock.increment(600_000);
    expect(calls.lost).not.toHaveBeenCalled();

    // A late start inside that run is reconciled as before.
    actor.send({ id: "delivery:first", type: "MESSAGE_STARTED" });
    actor.send({ type: "SESSION_SETTLED" });
    expect(calls.lost).not.toHaveBeenCalled();
    expect(calls.settled).toHaveBeenCalledOnce();
  });
});
