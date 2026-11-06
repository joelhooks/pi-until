import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import {
  suspensionDataSchema,
  pendingPredecessorSchema,
  SUSPENDED_ENTRY_TYPE,
  SUSPENSION_EXTRA_ENTRY_TYPE,
  RESUMED_ENTRY_TYPE,
  RESUME_INTENDED_ENTRY_TYPE,
} from "./suspension.ts";
import type { PendingPredecessor, SuspensionData } from "./suspension.ts";

const handoffSchema = Type.Object(
  {
    transferId: Type.String({ minLength: 1 }),
    suspension: suspensionDataSchema,
    pendingPredecessor: Type.Optional(pendingPredecessorSchema),
  },
  { additionalProperties: false }
);
export type Handoff = Readonly<
  Omit<Static<typeof handoffSchema>, "suspension">
> & {
  readonly suspension: SuspensionData;
};

export interface HandoffOptions {
  readonly directory: string;
  readonly predecessorId?: string;
  readonly successorId?: string;
  readonly waitMs?: number;
  readonly retentionMs?: number;
  readonly receiptRetentionMs?: number;
}

export const DEFAULT_HANDOFF_WAIT_MS = 30 * 60_000;
export const DEFAULT_HANDOFF_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;
const TEMP_RETENTION_MS = 24 * 60 * 60_000;

const positiveMilliseconds = (
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER
): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
};

export const handoffOptionsFromEnv = (
  env: NodeJS.ProcessEnv
): HandoffOptions => {
  const options: HandoffOptions = {
    directory: join(homedir(), ".pi", "agent", "pi-until", "handoff"),
    predecessorId:
      env.PI_UNTIL_SUCCEEDS?.trim() ||
      env.RATKING_SUCCEEDS?.trim() ||
      undefined,
    successorId: env.PI_UNTIL_SUCCESSOR_ID?.trim() || undefined,
    waitMs: positiveMilliseconds(
      env.PI_UNTIL_HANDOFF_WAIT_MS,
      DEFAULT_HANDOFF_WAIT_MS,
      2_147_483_647
    ),
    retentionMs: positiveMilliseconds(
      env.PI_UNTIL_HANDOFF_RETENTION_MS,
      DEFAULT_HANDOFF_RETENTION_MS
    ),
    receiptRetentionMs: positiveMilliseconds(
      env.PI_UNTIL_HANDOFF_RECEIPT_RETENTION_MS,
      DEFAULT_RECEIPT_RETENTION_MS
    ),
  };
  // A second loaded copy sees no private declaration; Rat King's value stays.
  delete env.PI_UNTIL_SUCCEEDS;
  delete env.PI_UNTIL_SUCCESSOR_ID;
  return options;
};

export const SUCCESSOR_ENTRY_TYPE = "pi-until-successor";
const bindingSchema = Type.Object(
  {
    predecessorId: Type.String(),
    successorId: Type.String(),
    notBefore: Type.Optional(Type.String()),
    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  },
  { additionalProperties: false }
);
export type SuccessorBinding = Static<typeof bindingSchema>;
export const successorBindingFrom = (
  entries: readonly SessionEntry[],
  successorId: string
): SuccessorBinding | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === SUCCESSOR_ENTRY_TYPE &&
      Value.Check(bindingSchema, entry.data) &&
      entry.data.successorId === successorId
    )
      return entry.data;
  }
  return undefined;
};

export const MAILBOX_CLEARED_ENTRY_TYPE = "pi-until-mailbox-cleared";

const timeField = (data: unknown, key: string): number => {
  if (typeof data !== "object" || data === null) return Number.NaN;
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
};

const sidecarTime = (
  data: unknown,
  entries: readonly SessionEntry[]
): number => {
  if (typeof data !== "object" || data === null || !("from" in data))
    return Number.NaN;
  const from = data.from;
  const core = entries.find((item) => item.id === from);
  return core?.type === "custom" &&
    core.customType === SUSPENDED_ENTRY_TYPE &&
    Value.Check(suspensionDataSchema, core.data)
    ? Date.parse(core.data.suspendedAt)
    : Number.NaN;
};

const ownEntryTime = (
  entry: SessionEntry,
  entries: readonly SessionEntry[]
): number => {
  if (entry.type !== "custom") return Number.NaN;
  const { data } = entry;
  switch (entry.customType) {
    case SUSPENDED_ENTRY_TYPE: {
      return Value.Check(suspensionDataSchema, data)
        ? Date.parse(data.suspendedAt)
        : Number.NaN;
    }
    case SUSPENSION_EXTRA_ENTRY_TYPE: {
      return sidecarTime(data, entries);
    }
    case RESUMED_ENTRY_TYPE:
    case RESUME_INTENDED_ENTRY_TYPE: {
      return timeField(data, "resumedAt");
    }
    case SUCCESSOR_ENTRY_TYPE: {
      return timeField(data, "notBefore");
    }
    case MAILBOX_CLEARED_ENTRY_TYPE: {
      return timeField(data, "clearedAt");
    }
    case "pi-until-started": {
      return typeof data === "object" && data !== null && "receipt" in data
        ? timeField(data.receipt, "startedAt")
        : Number.NaN;
    }
    case "pi-until-finished": {
      return timeField(data, "finishedAt");
    }
    default: {
      return Number.NaN;
    }
  }
};

export const forkPointFrom = (
  entries: readonly SessionEntry[],
  createdAt?: string
): string | undefined => {
  // Foreign shutdowns and distiller summaries cannot advance our fork floor.
  // Use our causal fields, never wrappers that a distiller may have restamped.
  const cutoff = Date.parse(createdAt ?? "");
  const times = entries
    .map((entry) => ownEntryTime(entry, entries))
    .filter(
      (time) =>
        Number.isFinite(time) && (!Number.isFinite(cutoff) || time <= cutoff)
    );
  return times.length === 0
    ? undefined
    : new Date(Math.max(...times)).toISOString();
};

export const discardOwnMailbox = async (
  directory: string,
  sessionId: string
): Promise<boolean> => {
  if (!validId(sessionId)) throw new Error("Unsafe session id");
  try {
    await unlink(join(directory, `${sessionId}.json`));
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
    return false;
  }
};

export const staleClaimCount = async (
  directory: string,
  now: number
): Promise<number> => {
  const paths = await filesIn(join(directory, "claimed"));
  const ages = await Promise.all(
    paths
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const metadata = await stat(join(directory, "claimed", name));
          return metadata.mtimeMs < now - DEFAULT_HANDOFF_RETENTION_MS;
        } catch (error) {
          if (missing(error)) return false;
          throw error;
        }
      })
  );
  return ages.filter(Boolean).length;
};

const claimName = (predecessorId: string, successorId: string): string =>
  `${predecessorId}!${successorId}.json`;
const legacyClaimName = (predecessorId: string, successorId: string): string =>
  `${predecessorId}.${successorId}.json`;

// IDs are path components, never paths. Reject traversal before touching disk.
const validId = (id: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/u.test(id);

const syncDirectory = async (directory: string): Promise<void> => {
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};

const writeAtomic = async (
  directory: string,
  target: string,
  data: unknown
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, join(directory, target));
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => {
      /* Retain the original write error. */
    });
  }
};

const tombstoneSchema = Type.Object(
  {
    empty: Type.Literal(true),
    sessionId: Type.String(),
    suspendedAt: Type.String(),
  },
  { additionalProperties: false }
);

export const publishHandoff = async (
  directory: string,
  suspension: SuspensionData,
  pendingPredecessor?: PendingPredecessor
): Promise<void> => {
  if (suspension.reason !== "quit" || !validId(suspension.sessionId))
    throw new Error("A handoff requires a graceful quit and a safe session id");
  const empty =
    suspension.watches.length === 0 &&
    (suspension.terminalFollowUps?.length ?? 0) === 0 &&
    pendingPredecessor === undefined;
  await writeAtomic(
    directory,
    `${suspension.sessionId}.json`,
    empty
      ? {
          empty: true,
          sessionId: suspension.sessionId,
          suspendedAt: suspension.suspendedAt,
        }
      : {
          suspension,
          transferId: randomUUID(),
          ...(pendingPredecessor === undefined ? {} : { pendingPredecessor }),
        }
  );
};

const receiptSchema = Type.Object(
  {
    predecessorId: Type.String(),
    successorId: Type.String(),
    transferId: Type.String(),
    suspendedAt: Type.String(),
    latestExpiresAt: Type.Union([Type.Number(), Type.Null()]),
  },
  { additionalProperties: false }
);

interface CompleteOptions {
  readonly directory: string;
  readonly predecessorId: string;
  readonly successorId: string;
  readonly handoff: Handoff;
}

/** Delete sensitive payload only after an ownership receipt is durable. */
export const completeHandoff = async ({
  directory,
  predecessorId,
  successorId,
  handoff,
}: CompleteOptions): Promise<void> => {
  if (!validId(predecessorId) || !validId(successorId))
    throw new Error("Unsafe handoff receipt ids");
  const { suspension, transferId } = handoff;
  const expiries = suspension.watches.map((item) => item.definition.expiresAt);
  // Terminal wakes have no independent expiry; receipt retention bounds them.
  const latestExpiresAt =
    expiries.length === 0 ||
    expiries.some((expiry) => expiry === undefined) ||
    (suspension.terminalFollowUps?.length ?? 0) > 0
      ? null
      : Math.max(...expiries.filter((expiry) => expiry !== undefined));
  const name = claimName(predecessorId, successorId);
  await writeAtomic(join(directory, "receipts"), name, {
    predecessorId,
    successorId,
    transferId,
    suspendedAt: suspension.suspendedAt,
    latestExpiresAt,
  });
  await unlink(join(directory, "claimed", name)).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  // Legacy dotted names can collide. Never delete a different pair's payload.
  const legacyPath = join(
    directory,
    "claimed",
    legacyClaimName(predecessorId, successorId)
  );
  const legacy = await readPrivate(legacyPath);
  if (
    Value.Check(handoffSchema, legacy) &&
    legacy.transferId === transferId &&
    legacy.suspension.sessionId === predecessorId
  )
    await unlink(legacyPath).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  await syncDirectory(join(directory, "claimed"));
};

export const completeOwnHandoff = async (
  directory: string,
  sessionId: string
): Promise<void> => {
  if (!validId(sessionId)) throw new Error("Unsafe session id");
  try {
    const target = join(directory, "claimed", claimName(sessionId, sessionId));
    const text = await readFile(target, "utf-8").catch((error: unknown) => {
      if (!missing(error)) throw error;
      return readFile(
        join(directory, "claimed", legacyClaimName(sessionId, sessionId)),
        "utf-8"
      );
    });
    const data: unknown = JSON.parse(text);
    if (!Value.Check(handoffSchema, data))
      throw new Error("Invalid own handoff claim; retained for inspection");
    await completeHandoff({
      directory,
      predecessorId: sessionId,
      successorId: sessionId,
      handoff: data,
    });
  } catch (error) {
    if (!missing(error)) throw error;
  }
};

const filesIn = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
};

type MailboxWarning = (message: string) => void;

const readPrivate = async (
  path: string,
  warn?: MailboxWarning
): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    if (!missing(error))
      warn?.(`pi-until skipped unreadable mailbox file ${basename(path)}`);
    return undefined;
  }
};

export const pruneHandoffs = async ({
  directory,
  now,
  retentionMs = DEFAULT_HANDOFF_RETENTION_MS,
  receiptRetentionMs = DEFAULT_RECEIPT_RETENTION_MS,
  warn,
}: {
  directory: string;
  now: number;
  retentionMs?: number;
  receiptRetentionMs?: number;
  warn?: MailboxWarning;
}): Promise<void> => {
  await Promise.all(
    [directory, join(directory, "claimed"), join(directory, "receipts")].map(
      async (folder) => {
        const names = await filesIn(folder);
        await Promise.all(
          names.map(async (name) => {
            const path = join(folder, name);
            try {
              const metadata = await stat(path);
              if (name.startsWith(".") && name.endsWith(".tmp")) {
                if (metadata.mtimeMs < now - TEMP_RETENTION_MS)
                  await unlink(path);
              } else if (
                folder === directory &&
                name.endsWith(".json") &&
                validId(name.slice(0, -5))
              ) {
                if (metadata.mtimeMs < now - retentionMs) await unlink(path);
              } else if (
                folder === join(directory, "receipts") &&
                name.endsWith(".json")
              ) {
                const data = await readPrivate(path, warn);
                if (Value.Check(receiptSchema, data)) {
                  const expired =
                    data.latestExpiresAt === null
                      ? metadata.mtimeMs < now - receiptRetentionMs
                      : data.latestExpiresAt <= now;
                  if (expired) await unlink(path);
                } else if (data !== undefined)
                  warn?.(`pi-until skipped invalid receipt ${name}`);
              }
            } catch (error) {
              if (!missing(error))
                warn?.(`pi-until could not prune mailbox file ${name}`);
            }
          })
        );
      }
    )
  );
};

/** A same-session restart competes for the same quit, not a second copy. */
export const consumeOwnHandoff = async (options: {
  readonly directory: string;
  readonly sessionId: string;
  readonly suspendedAt?: string;
  readonly warn?: MailboxWarning;
  readonly list?: (directory: string) => Promise<string[]>;
  readonly onTransferred?: (transferId: string) => void;
}): Promise<boolean> => {
  const { directory, sessionId, suspendedAt, warn } = options;
  const list = options.list ?? filesIn;
  if (!validId(sessionId)) throw new Error("Unsafe session id");
  const claimed = join(directory, "claimed");
  try {
    await mkdir(claimed, { recursive: true, mode: 0o700 });
    await rename(
      join(directory, `${sessionId}.json`),
      join(claimed, claimName(sessionId, sessionId))
    );
    await syncDirectory(directory);
    await syncDirectory(claimed);
    return true;
  } catch (error) {
    if (!missing(error))
      warn?.(
        "pi-until mailbox consume failed; checking existing ownership before transcript recovery"
      );
  }
  const evidenceIn = async (folder: "claimed" | "receipts") => {
    const path = join(directory, folder);
    const names = await list(path).catch(() => {
      warn?.(`pi-until could not inspect ${folder}`);
      return [];
    });
    return Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(`${sessionId}!`) || name.startsWith(`${sessionId}.`)
        )
        .map(async (name) => {
          const data = await readPrivate(join(path, name), warn);
          if (folder === "claimed" && Value.Check(handoffSchema, data)) {
            const matches =
              data.suspension.sessionId === sessionId &&
              data.suspension.suspendedAt === suspendedAt;
            const own =
              name === claimName(sessionId, sessionId) ||
              name === legacyClaimName(sessionId, sessionId);
            if (matches && !own) options.onTransferred?.(data.transferId);
            return matches && !own;
          }
          if (folder === "receipts" && Value.Check(receiptSchema, data)) {
            const matches =
              data.predecessorId === sessionId &&
              data.suspendedAt === suspendedAt;
            if (matches) options.onTransferred?.(data.transferId);
            return matches;
          }
          if (data !== undefined)
            warn?.(`pi-until skipped invalid mailbox file ${name}`);
          return false;
        })
    );
  };
  // Completion creates the receipt before removing the claim. Listing in this
  // order cannot miss both representations while ownership moves between them.
  const claimedEvidence = await evidenceIn("claimed");
  const receiptEvidence = await evidenceIn("receipts");
  // ENOENT without matching evidence is the ordinary legacy-version path.
  return ![...claimedEvidence, ...receiptEvidence].some(Boolean);
};

type ClaimResult =
  | { readonly kind: "claimed"; readonly handoff: Handoff }
  | { readonly kind: "empty" }
  | { readonly kind: "nothing" }
  | { readonly kind: "aborted" };

interface ClaimOptions {
  readonly directory: string;
  readonly predecessorId: string;
  readonly successorId: string;
  readonly signal: AbortSignal;
  readonly waitMs?: number;
  readonly warn?: MailboxWarning;
  readonly sync?: (directory: string) => Promise<void>;
  readonly notBefore?: string;
  readonly passive?: boolean;
  readonly onTimeout?: (watching: boolean) => void;
}

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Rename consumes the one source name, even when claimants use different
 * destinations. A claimant can recover its own claim after dying before its
 * session journal commit. The extension rejects already-journalled transfers.
 * One process must own a session id: two live processes with the same id would
 * both recover that identity's claim, which is not a supported ownership model.
 */
export const claimHandoff = async (
  options: ClaimOptions
): Promise<ClaimResult> => {
  const { directory, predecessorId, successorId, signal } = options;
  if (
    !validId(predecessorId) ||
    !validId(successorId) ||
    predecessorId === successorId
  ) {
    throw new Error("Successor handoff requires distinct safe session ids");
  }
  const claimedDirectory = join(directory, "claimed");
  await mkdir(claimedDirectory, { recursive: true, mode: 0o700 });
  const source = join(directory, `${predecessorId}.json`);
  const target = join(claimedDirectory, claimName(predecessorId, successorId));
  const legacyTarget = join(
    claimedDirectory,
    legacyClaimName(predecessorId, successorId)
  );
  const fresh = (data: unknown): boolean => {
    const floor = Date.parse(options.notBefore ?? "");
    let timestamp: string | undefined;
    if (Value.Check(handoffSchema, data))
      timestamp = data.suspension.suspendedAt;
    else if (Value.Check(tombstoneSchema, data)) timestamp = data.suspendedAt;
    return (
      !Number.isFinite(floor) ||
      timestamp === undefined ||
      Date.parse(timestamp) >= floor
    );
  };
  const attempt = async (): Promise<Handoff | "nothing" | undefined> => {
    try {
      // Recovery must precede rename: never overwrite this successor's claim.
      let claim = target;
      try {
        await readFile(target, "utf-8");
      } catch (error) {
        if (!missing(error)) throw error;
        const legacy = await readPrivate(legacyTarget, options.warn);
        if (
          Value.Check(handoffSchema, legacy) &&
          legacy.suspension.sessionId === predecessorId
        ) {
          claim = legacyTarget;
        } else {
          const pending = await readPrivate(source, options.warn);
          if (pending !== undefined && !fresh(pending)) return undefined;
          await rename(source, target);
          try {
            const sync = options.sync ?? syncDirectory;
            await sync(directory);
            await sync(claimedDirectory);
          } catch {
            options.warn?.(
              "pi-until claim directory fsync failed; recovering the renamed claim by readback"
            );
          }
        }
      }
      const data: unknown = JSON.parse(await readFile(claim, "utf-8"));
      if (!fresh(data)) {
        await rename(
          claim,
          join(
            claimedDirectory,
            `${basename(claim)}.stale-${randomUUID()}.json`
          )
        );
        return attempt();
      }
      if (
        Value.Check(tombstoneSchema, data) &&
        data.sessionId === predecessorId
      ) {
        await unlink(claim);
        return "nothing";
      }
      if (
        !Value.Check(handoffSchema, data) ||
        data.suspension.reason !== "quit" ||
        data.suspension.sessionId !== predecessorId
      ) {
        throw new Error(
          "Invalid pi-until handoff; claim retained for inspection"
        );
      }
      return data;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };

  // Subscribe before the first read, closing the publish/read/watch race.
  // fs.watch is the fast path; a bounded interval covers dropped OS events.
  return new Promise<ClaimResult>((resolve, reject) => {
    let done = false;
    let checking = false;
    let dirty = false;
    let ending: "aborted" | "empty" | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    let passiveWatching = false;
    const finish = (result: ClaimResult | Error) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const check = async () => {
      if (done) return;
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        const handoff = await attempt();
        if (handoff === "nothing") finish({ kind: "nothing" });
        else if (handoff !== undefined) finish({ handoff, kind: "claimed" });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
        if (ending !== undefined) finish({ kind: ending });
        else if (dirty) {
          dirty = false;
          void check();
        }
      }
    };
    const abort = () => {
      // An in-flight rename must finish before its owner tears down.
      ending = "aborted";
      if (!checking) finish({ kind: "aborted" });
    };
    const poll = setInterval(() => {
      void check();
    }, 250);
    const deadline = setTimeout(() => {
      clearInterval(poll);
      const watching = options.passive === true && watcher !== undefined;
      options.onTimeout?.(watching);
      if (watching) {
        passiveWatching = true;
        return;
      }
      ending = "empty";
      if (!checking) finish({ kind: "empty" });
    }, options.waitMs ?? DEFAULT_HANDOFF_WAIT_MS);
    signal.addEventListener("abort", abort, { once: true });
    try {
      watcher = watch(directory, () => {
        void check();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
        if (passiveWatching) {
          options.warn?.(
            "pi-until late filesystem watcher failed; reload or re-arm manually"
          );
          finish({ kind: "empty" });
        }
      });
    } catch {
      // Poll fallback remains bounded if native watching is unavailable.
    }
    if (signal.aborted) finish({ kind: "aborted" });
    else void check();
  });
};
