import type { FollowUpSnapshot } from "./domain.ts";
import type { HandoffReleaseReason } from "./predecessor.ts";

export interface RecurringPacketReceipt {
  readonly deliveredAt: number;
  readonly delivery: number;
  readonly expiresAt: number;
  readonly id: string;
  readonly missedTicks: number;
  readonly nextDueAt?: number;
  readonly reloads: number;
}

const iso = (value: number): string => new Date(value).toISOString();

/** A release permits manual re-arming, never restoration from inventory. */
export const renderHandoffReleasePacket = (
  predecessorId: string,
  inventoryIds: readonly string[],
  reason: HandoffReleaseReason = "predecessor-gone",
  successorId?: string
): string =>
  [
    reason === "deadline-no-record"
      ? `pi-until handoff released: predecessor \`${predecessorId}\` never handed off before the deadline; no liveness record is available.`
      : `pi-until handoff released: predecessor \`${predecessorId}\` is gone and no publication arrived during the death grace.`,
    ...(successorId === undefined
      ? []
      : [
          `This permission belongs only to successor \`${successorId}\` while no new handoff is pending; forks do not inherit it.`,
        ]),
    ...(reason === "deadline-no-record"
      ? [
          "The predecessor may still be running; confirm it has stopped before re-arming. Reopening that predecessor later can restore its watches; check handled work there too.",
        ]
      : []),
    `Inventory ids: ${inventoryIds.map((id) => `\`${id}\``).join(", ") || "unavailable"}.`,
    "If `until list` shows a pending handoff, this release does not apply.",
    "Some ids may already be re-armed; check `until list` above before starting more work.",
    "Re-arm as needed from the advisory inventory after checking handled work. Inventory is not active here and is never restoration authority.",
  ].join("\n");

const contextLines = (snapshot: FollowUpSnapshot): string[] => {
  const lines = [
    snapshot.origin.entryId === undefined
      ? `- Session: \`${snapshot.origin.sessionId}\``
      : `- Session entry: \`${snapshot.origin.entryId}\` in \`${snapshot.origin.sessionId}\``,
  ];
  for (const reference of snapshot.contextRefs) {
    lines.push(`- ${reference.label}: \`${reference.target}\``);
  }
  return lines;
};

export const renderRecurringWakePacket = (
  snapshot: FollowUpSnapshot,
  receipt: RecurringPacketReceipt
): string =>
  [
    "# Recurring follow-up",
    "",
    "## Instruction",
    snapshot.instruction,
    "",
    "## Quick reference",
    snapshot.quickRef,
    "",
    "## Receipt",
    `- Watch: \`${receipt.id}\``,
    `- Delivery: ${receipt.delivery}`,
    `- Missed ticks: ${receipt.missedTicks}`,
    `- Delivered: ${iso(receipt.deliveredAt)}`,
    `- Next due: ${receipt.nextDueAt === undefined ? "none" : iso(receipt.nextDueAt)}`,
    `- Expires: ${iso(receipt.expiresAt)}`,
    `- Survived reloads: ${receipt.reloads}`,
    "",
    "## Context",
    ...contextLines(snapshot),
    "",
    "## Control",
    `Call \`until\` with \`action=complete\` and \`id=${receipt.id}\` when the goal is achieved.`,
    `Call \`until\` with \`action=cancel\` and \`id=${receipt.id}\` to abort it.`,
  ].join("\n");

export const renderRecurringExpiredPacket = (
  snapshot: FollowUpSnapshot,
  receipt: Omit<RecurringPacketReceipt, "deliveredAt" | "nextDueAt">
): string =>
  [
    "# Recurring follow-up expired",
    "",
    "This recurrence is no longer active. Do not continue its task unless the user asks.",
    "Reading a finished watch with status or cancel drops only its queued terminal wake; list does not consume wakes, and already dispatched wakes still settle normally.",
    "",
    "## Quick reference",
    snapshot.quickRef,
    "",
    "## Receipt",
    `- Watch: \`${receipt.id}\``,
    "- Status: expired",
    `- Deliveries: ${receipt.delivery}`,
    `- Missed ticks: ${receipt.missedTicks}`,
    `- Expired: ${iso(receipt.expiresAt)}`,
    `- Survived reloads: ${receipt.reloads}`,
    "",
    "## Context",
    ...contextLines(snapshot),
  ].join("\n");
