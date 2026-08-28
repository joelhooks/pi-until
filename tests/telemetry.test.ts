import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTelemetrySink,
  describeCondition,
  parseTelemetryLines,
  readTelemetry,
  summarizeTelemetry,
  summaryText,
  telemetryOptionsFromEnv,
} from "../src/telemetry.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("telemetry", () => {
  it("describes a condition without keeping the command", () => {
    const described = describeCondition(
      "  /usr/bin/gh run view 123 --exit-status "
    );
    expect(described.head).toBe("gh");
    expect(described.hash).toHaveLength(12);
    expect(described.hash).toBe(
      describeCondition("/usr/bin/gh run view 123 --exit-status").hash
    );
    expect(describeCondition("").head).toBe("(empty)");
    expect(describeCondition("-f x").head).toBe("(empty)");
  });

  it("appends JSONL events and reads them back, skipping garbage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-telemetry-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "nested", "events.jsonl");
    const sink = createTelemetrySink({
      filePath,
      now: () => 1_700_000_000_000,
    });

    await sink.record("s1", {
      action: "start",
      event: "action",
      source: "tool",
    });
    await sink.record("s1", {
      checkTimeoutMs: 30_000,
      conditionHash: "abc",
      conditionHead: "test",
      event: "started",
      id: "w1",
      intervalMs: 30_000,
      label: "x",
      resumed: false,
      wake: "agent",
    });
    const raw = readFileSync(filePath, "utf-8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw).toContain('"at":"2023-11-14T22:13:20.000Z"');
    expect(raw).not.toContain("secret");

    const events = await readTelemetry(filePath);
    expect(events.map((event) => event.event)).toEqual(["action", "started"]);
    expect(parseTelemetryLines('not json\n{"event":"bogus"}\n')).toEqual([]);
    expect(await readTelemetry(join(directory, "missing.jsonl"))).toEqual([]);
  });

  it("does nothing when disabled and reads env for options", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-until-telemetry-"));
    tempDirectories.push(directory);
    const filePath = join(directory, "events.jsonl");
    const sink = createTelemetrySink({ enabled: false, filePath });
    await sink.record("s", { count: 1, event: "suspended" });
    expect(await readTelemetry(filePath)).toEqual([]);

    expect(telemetryOptionsFromEnv({ PI_UNTIL_TELEMETRY: "0" })).toMatchObject({
      enabled: false,
    });
    expect(
      telemetryOptionsFromEnv({ PI_UNTIL_TELEMETRY_FILE: " /x/y.jsonl " })
    ).toMatchObject({
      enabled: true,
      filePath: "/x/y.jsonl",
    });
  });

  it("summarizes usage", () => {
    const base = { at: "t", sessionId: "s1", v: 1 as const };
    const summary = summarizeTelemetry([
      { ...base, action: "start", event: "action", source: "tool" },
      {
        ...base,
        checkTimeoutMs: 1,
        conditionHash: "a",
        conditionHead: "gh",
        event: "started",
        id: "1",
        intervalMs: 1,
        label: "l",
        resumed: false,
        wake: "agent",
      },
      {
        ...base,
        checkTimeoutMs: 1,
        conditionHash: "b",
        conditionHead: "test",
        event: "started",
        id: "2",
        intervalMs: 1,
        label: "l",
        resumed: false,
        wake: "notify",
      },
      {
        ...base,
        checkTimeoutMs: 1,
        conditionHash: "b",
        conditionHead: "test",
        event: "started",
        id: "2",
        intervalMs: 1,
        label: "l",
        resumed: true,
        wake: "notify",
      },
      {
        ...base,
        attempts: 3,
        conditionHash: "a",
        durationMs: 90_000,
        event: "finished",
        id: "1",
        reloads: 0,
        status: "succeeded",
        wake: "agent",
      },
      {
        ...base,
        sessionId: "s2",
        attempts: 9,
        conditionHash: "b",
        durationMs: 10_000,
        event: "finished",
        id: "2",
        reloads: 1,
        status: "timedOut",
        wake: "notify",
      },
      { ...base, count: 1, event: "suspended" },
      { ...base, count: 1, event: "resumed" },
    ]);
    expect(summary).toMatchObject({
      actions: { "tool:start": 1 },
      byStatus: { succeeded: 1, timedOut: 1 },
      byWake: { agent: 1, notify: 1 },
      finished: 2,
      medianAttempts: 6,
      medianDurationMs: 50_000,
      resumedWatches: 1,
      sessions: 2,
      started: 2,
      suspendedWatches: 1,
      topHeads: [
        { count: 1, head: "gh" },
        { count: 1, head: "test" },
      ],
    });
    const text = summaryText(summary, "/x.jsonl");
    expect(text).toContain("Watches started: 2  finished: 2");
    expect(text).toContain("median duration: 50.0s");
    expect(text).toContain("Top conditions: gh=1 test=1");
  });
});
