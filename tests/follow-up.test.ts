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
