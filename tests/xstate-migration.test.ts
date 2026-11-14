import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";

import { phaseOffsetMs } from "../src/domain.ts";
import { createWatchMachine } from "../src/machine.ts";
import {
  SUSPENDED_ENTRY_TYPE,
  journalSuspensionData,
  newestSuspension,
  resumeInput,
  suspendWatch,
  suspensionData,
} from "../src/suspension.ts";
import { FakeSession, loadExtension } from "./fake-pi.ts";
import fixture from "./fixtures/xstate5-suspension.json" with { type: "json" };

const capturedAt = fixture.generator.capturedAt;

const savedSession = () => {
  const session = new FakeSession(new Date(0).toISOString());
  session.appendCustom(
    SUSPENDED_ENTRY_TYPE,
    fixture.data,
    fixture.data.suspendedAt
  );
  return session;
};

const savedWatches = () => {
  const saved = newestSuspension(savedSession().entries);
  if (saved === undefined) throw new Error("v5 fixture must parse");
  return saved.watches;
};

describe("XState 5.32.5 suspension compatibility", () => {
  it.each(savedWatches())(
    "restores v5-saved watch $facts.id with the same state, facts and phase",
    (watch) => {
      expect(savedWatches()).toEqual(fixture.data.watches);
      expect(savedWatches()).toHaveLength(fixture.expected.length);
      const expected = fixture.expected.find(
        (item) => item.id === watch.facts.id
      );
      const clock = new SimulatedClock();
      clock.set(capturedAt);
      const actor = createActor(
        createWatchMachine(async () => ({ code: 1, killed: false }), clock),
        { clock, input: resumeInput(watch) }
      ).start();
      try {
        expect(actor.getSnapshot().context).toEqual(watch);
        expect(actor.getSnapshot().value).toEqual(expected?.state);
        expect(phaseOffsetMs(watch.definition, watch.facts.id)).toBe(
          expected?.phase
        );
      } finally {
        actor.stop();
      }
    }
  );

  it("writes the identical v3 wire format, not a v6 actor snapshot", () => {
    const written = journalSuspensionData(
      suspensionData(
        savedWatches().map((watch) => suspendWatch(resumeInput(watch), false)),
        capturedAt,
        "reload",
        fixture.data.sessionId
      )
    );
    const wire = JSON.stringify(written);
    expect(JSON.parse(wire)).toEqual(fixture.data);
    expect(Object.keys(written).sort()).toEqual([
      "reason",
      "sessionId",
      "suspendedAt",
      "v",
      "watches",
    ]);
  });

  it("restores the v5 journal through Pi's reload boundary without dropping watches", async () => {
    const session = savedSession();
    const clock = new SimulatedClock();
    clock.set(capturedAt);
    const extension = loadExtension(session, { clock, handoff: false });
    const { ctx } = session.context({ idle: false });
    try {
      await extension.sessionStart("reload", ctx);
      const result = await extension.tool(
        "list",
        { action: "list" },
        new AbortController().signal,
        undefined,
        ctx
      );
      if (result.details === undefined || !("watches" in result.details)) {
        throw new Error("expected restored watch inventory");
      }
      expect(result.details.watches.map((watch) => watch.id).sort()).toEqual(
        fixture.expected.map((watch) => watch.id).sort()
      );
      expect(extension.messages).toHaveLength(0);
      await extension.shutdown("reload", ctx);
      const written = newestSuspension(session.entries);
      expect(written?.watches).toEqual(
        savedWatches().map((watch) => ({
          ...watch,
          facts: { ...watch.facts, reloads: watch.facts.reloads + 1 },
        }))
      );
    } finally {
      await extension.shutdown("quit", ctx);
    }
  });
});
