import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  renderWatchIndicator,
  renderWatchPanel,
  type WatchDisplay,
} from "../src/indicator.ts";

// SAFETY: indicator tests use only Theme.bold and Theme.fg.
const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as Theme;

function watch(overrides: Partial<WatchDisplay> = {}): WatchDisplay {
  return {
    attempts: 5,
    deliveries: 0,
    id: "8f2c1a7d",
    intervalMs: 30_000,
    kind: "until",
    label: "deploy verification",
    missedTicks: 0,
    nextDueAt: 130_000,
    phase: "sleeping",
    startedAt: -34_000,
    status: "running",
    wake: "agent",
    ...overrides,
  };
}

describe("pi-until watch indicator", () => {
  it("shows one session watch as a framed live card", () => {
    const lines = renderWatchIndicator([watch()], 100_000, 64, theme);

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("UNTIL · deploy verification");
    expect(lines.join("\n")).toContain("next 30s");
    expect(lines.join("\n")).toContain("2m14s elapsed");
    expect(lines.join("\n")).toContain("5 checks");
    expect(lines.join("\n")).toContain("wakes agent");
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true);
  });

  it("shows recurring delivery and missed-tick counts", () => {
    const lines = renderWatchIndicator(
      [
        watch({
          attempts: 0,
          deliveries: 3,
          kind: "recurring",
          missedTicks: 2,
        }),
      ],
      100_000,
      64,
      theme
    );

    expect(lines.join("\n")).toContain("3 wakes · 2 missed");
    expect(lines.join("\n")).toContain("recurring");
  });

  it("compresses multiple watches and points to the full panel", () => {
    const lines = renderWatchIndicator(
      [
        watch({ id: "one", label: "first" }),
        watch({ id: "two", label: "second" }),
        watch({ id: "three", label: "third" }),
        watch({ id: "four", label: "fourth" }),
      ],
      100_000,
      52,
      theme
    );

    expect(lines.join("\n")).toContain("4 session watches");
    expect(lines.join("\n")).toContain("+1 more");
    expect(lines.join("\n")).toContain("/until-list for details");
    expect(lines.every((line) => visibleWidth(line) === 52)).toBe(true);
  });

  it("renders terminal watch states in the scrollable panel", () => {
    const lines = renderWatchPanel(
      [
        watch({ status: "succeeded", phase: undefined }),
        watch({
          id: "failed",
          label: "failed watch",
          status: "failed",
          phase: undefined,
        }),
      ],
      100_000,
      60,
      0,
      6,
      "up/down scroll · escape close",
      theme
    );

    expect(lines.join("\n")).toContain("succeeded");
    expect(lines.join("\n")).toContain("failed watch");
    expect(lines.join("\n")).toContain("1-2 of 2");
    expect(lines.every((line) => visibleWidth(line) === 60)).toBe(true);
  });

  it("does not render the card when no watch is active", () => {
    expect(renderWatchIndicator([], 100_000, 64, theme)).toEqual([]);
  });
});
