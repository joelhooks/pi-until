import type { FollowUpSnapshot } from "./domain.ts";

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
