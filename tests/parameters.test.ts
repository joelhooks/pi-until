import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  parseUntilCommand,
  prepareUntilArguments,
  untilParameters,
} from "../src/command.ts";

const context = {
  cwd: process.cwd(),
  entryId: "entry-1",
  sessionId: "session-1",
  startedAt: 1_000,
};

describe("until tool parameters", () => {
  it("uses one provider-compatible root object schema", () => {
    expect(untilParameters.type).toBe("object");
    expect("anyOf" in untilParameters).toBe(false);
  });

  it("repairs the stringified argument shape emitted by the tool bridge", () => {
    const prepared = prepareUntilArguments({
      action: "repeat",
      checkTimeoutSeconds: "30",
      condition: "test -f ready",
      contextRefs: '[{"label":"Runbook","target":"docs/release.md"}]',
      immediate: "true",
      instruction: "Inspect the release.",
      intervalSeconds: "600",
      label: "release check",
      quickRef: "Release 42",
      timeoutSeconds: "604800",
      wake: "agent",
    });

    expect(prepared).toMatchObject({
      checkTimeoutSeconds: 30,
      contextRefs: [{ label: "Runbook", target: "docs/release.md" }],
      immediate: true,
      intervalSeconds: 600,
      timeoutSeconds: 604_800,
    });
    expect(Value.Check(untilParameters, prepared)).toBe(true);
  });

  it("parses a normalized transport value into one immutable command", () => {
    const prepared = prepareUntilArguments({
      action: "repeat",
      contextRefs: '[{"label":"Runbook","target":"docs/release.md"}]',
      immediate: "true",
      instruction: "Inspect the release.",
      intervalSeconds: "600",
      quickRef: "Release 42",
      timeoutSeconds: "604800",
    });
    const command = parseUntilCommand(prepared, context);

    expect(command).toMatchObject({
      action: "repeat",
      definition: {
        expiresAt: 604_801_000,
        first: "now",
        intervalMs: 600_000,
        kind: "recurring",
      },
      startedAt: 1_000,
    });
    if (command.action !== "repeat") throw new Error("expected repeat command");
    expect(Object.isFrozen(command.definition.snapshot)).toBe(true);
    expect(Object.isFrozen(command.definition.snapshot.contextRefs)).toBe(true);
  });

  it("rejects values that bypass the public tool boundary", () => {
    expect(() =>
      parseUntilCommand(
        {
          action: "repeat",
          instruction: "Too fast.",
          intervalSeconds: 0.01,
          quickRef: "invalid interval",
          timeoutSeconds: 10,
        },
        context
      )
    ).toThrow("invalid until parameters");
    expect(() => parseUntilCommand({ action: "status" }, context)).toThrow(
      "id is required for action=status"
    );
  });

  it("leaves malformed compatibility values for normal validation", () => {
    const prepared = prepareUntilArguments({
      action: "repeat",
      contextRefs: "not JSON",
      intervalSeconds: "often",
    });

    expect(prepared).toMatchObject({
      contextRefs: "not JSON",
      intervalSeconds: "often",
    });
    expect(Value.Check(untilParameters, prepared)).toBe(false);
  });
});
