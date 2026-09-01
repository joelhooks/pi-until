import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  prepareUntilArguments,
  untilParameters,
} from "../extensions/pi-until.ts";

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
