import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type WatchDisplayStatus =
  | "running"
  | "succeeded"
  | "timedOut"
  | "cancelled"
  | "failed";

export type WatchPhase = "checking" | "sleeping";

export interface WatchDisplay {
  readonly attempts: number;
  readonly id: string;
  readonly intervalMs: number;
  readonly label: string;
  readonly lastCheckedAt?: number;
  readonly phase?: WatchPhase;
  readonly startedAt: number;
  readonly status: WatchDisplayStatus;
  readonly wake: "agent" | "notify";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_WIDGET_ROWS = 3;
const MIN_FRAME_WIDTH = 24;

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length] ?? "⠋";
}

function nextCheckText(watch: WatchDisplay, now: number): string | undefined {
  if (
    watch.status !== "running" ||
    watch.phase !== "sleeping" ||
    watch.lastCheckedAt === undefined
  ) {
    return undefined;
  }
  return `next ${formatDuration(watch.lastCheckedAt + watch.intervalMs - now)}`;
}

function statusText(watch: WatchDisplay, now: number): string {
  if (watch.status !== "running") return watch.status;
  if (watch.phase === "checking") return "checking";
  return nextCheckText(watch, now) ?? "sleeping";
}

function statusIcon(watch: WatchDisplay, now: number, theme: Theme): string {
  if (watch.status === "succeeded") return theme.fg("success", "✓");
  if (watch.status === "failed" || watch.status === "timedOut") {
    return theme.fg("error", "✗");
  }
  if (watch.status === "cancelled") return theme.fg("muted", "■");
  if (watch.phase === "checking") return theme.fg("accent", spinnerFrame(now));
  return theme.fg("warning", "◷");
}

function topBorder(title: string, width: number, theme: Theme): string {
  const titleWidth = Math.max(1, width - 6);
  const renderedTitle = truncateToWidth(title, titleWidth, "");
  const fill = "─".repeat(Math.max(0, width - visibleWidth(renderedTitle) - 5));
  return (
    theme.fg("borderMuted", "╭─ ") +
    renderedTitle +
    theme.fg("borderMuted", ` ${fill}╮`)
  );
}

function row(content: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(1, width - 4);
  const rendered = truncateToWidth(content, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(rendered)));
  return (
    theme.fg("borderMuted", "│ ") +
    rendered +
    padding +
    theme.fg("borderMuted", " │")
  );
}

function bottomBorder(content: string, width: number, theme: Theme): string {
  const contentWidth = Math.max(1, width - 6);
  const rendered = truncateToWidth(content, contentWidth, "");
  const fill = "─".repeat(Math.max(0, width - visibleWidth(rendered) - 5));
  return (
    theme.fg("borderMuted", "╰─ ") +
    rendered +
    theme.fg("borderMuted", ` ${fill}╯`)
  );
}

function watchMetrics(watch: WatchDisplay, now: number, theme: Theme): string {
  const parts = [
    statusText(watch, now),
    `${formatDuration(now - watch.startedAt)} elapsed`,
    `${watch.attempts} ${watch.attempts === 1 ? "check" : "checks"}`,
  ];
  return theme.fg("muted", parts.join(" · "));
}

export function renderWatchIndicator(
  watches: readonly WatchDisplay[],
  now: number,
  width: number,
  theme: Theme
): string[] {
  if (watches.length === 0 || width < MIN_FRAME_WIDTH) return [];

  if (watches.length === 1) {
    const watch = watches[0];
    if (!watch) return [];
    const title =
      theme.fg("accent", theme.bold("UNTIL")) +
      theme.fg("dim", " · ") +
      theme.fg("text", watch.label);
    const body = `${statusIcon(watch, now, theme)} ${watchMetrics(watch, now, theme)}`;
    const footer = theme.fg(
      "dim",
      `${watch.id} · wakes ${watch.wake} · /until-list`
    );
    return [
      topBorder(title, width, theme),
      row(body, width, theme),
      bottomBorder(footer, width, theme),
    ];
  }

  const title =
    theme.fg("accent", theme.bold("UNTIL")) +
    theme.fg("dim", ` · ${watches.length} session watches`);
  const visible = watches.slice(0, MAX_WIDGET_ROWS);
  const lines = [topBorder(title, width, theme)];
  for (const watch of visible) {
    const body = `${statusIcon(watch, now, theme)} ${theme.fg(
      "text",
      watch.label
    )}${theme.fg("dim", ` · ${statusText(watch, now)} · #${watch.attempts}`)}`;
    lines.push(row(body, width, theme));
  }
  if (watches.length > visible.length) {
    lines.push(
      row(
        theme.fg("dim", `+${watches.length - visible.length} more`),
        width,
        theme
      )
    );
  }
  lines.push(
    bottomBorder(theme.fg("dim", "/until-list for details"), width, theme)
  );
  return lines;
}

export function renderWatchPanel(
  watches: readonly WatchDisplay[],
  now: number,
  width: number,
  offset: number,
  limit: number,
  navigationHint: string,
  theme: Theme
): string[] {
  if (width < MIN_FRAME_WIDTH) return [];

  const safeOffset = Math.min(
    Math.max(0, offset),
    Math.max(0, watches.length - 1)
  );
  const visible = watches.slice(safeOffset, safeOffset + limit);
  const title =
    theme.fg("accent", theme.bold("PI UNTIL")) +
    theme.fg("dim", " · session watches");
  const lines = [topBorder(title, width, theme)];

  if (visible.length === 0) {
    lines.push(
      row(theme.fg("muted", "No watches in this session."), width, theme)
    );
  } else {
    for (const watch of visible) {
      lines.push(
        row(
          `${statusIcon(watch, now, theme)} ${theme.fg("text", watch.label)}`,
          width,
          theme
        ),
        row(
          theme.fg(
            "dim",
            `${watch.id} · ${statusText(watch, now)} · ${formatDuration(now - watch.startedAt)} elapsed · ${watch.attempts} checks · wakes ${watch.wake}`
          ),
          width,
          theme
        )
      );
    }
  }

  const first = watches.length === 0 ? 0 : safeOffset + 1;
  const last = Math.min(watches.length, safeOffset + visible.length);
  const position = `${first}-${last} of ${watches.length}`;
  lines.push(
    bottomBorder(
      theme.fg("dim", `${navigationHint} · ${position}`),
      width,
      theme
    )
  );
  return lines;
}
