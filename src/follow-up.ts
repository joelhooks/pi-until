import { setup, types } from "xstate";

interface FollowUpRequestBase {
  readonly dedupeKey: string;
  readonly id: string;
  /** Set when the first dispatch was lost and this is the one retry. */
  readonly retried?: boolean;
  readonly watchId: string;
}

export type FollowUpRequest =
  | (FollowUpRequestBase & {
      readonly dispatchedAt?: number;
      readonly kind: "recurring";
    })
  | (FollowUpRequestBase & {
      readonly content: string;
      readonly customType: string;
      readonly details: unknown;
      readonly kind: "terminal";
    });

export interface FollowUpMachineInput {
  readonly sessionBusy: boolean;
}

export interface FollowUpContext {
  readonly active?: FollowUpRequest;
  /** Pi is compacting the session. Only the idle states hold on it. */
  readonly compacting: boolean;
  readonly queue: readonly FollowUpRequest[];
  readonly sessionBusy: boolean;
}

export type FollowUpEvent =
  | { readonly request: FollowUpRequest; readonly type: "ENQUEUE" }
  | { readonly dedupeKey: string; readonly type: "DROP" }
  | { readonly id: string; readonly type: "DISPATCH_FAILED" }
  | { readonly id: string; readonly type: "MESSAGE_STARTED" }
  | { readonly type: "COMPACTION_STARTED" }
  | { readonly type: "COMPACTION_ENDED" }
  | { readonly type: "SESSION_BUSY" }
  | { readonly type: "SESSION_SETTLED" };

export interface FollowUpPorts {
  readonly compactionGraceMs?: number;
  readonly dispatch: (request: FollowUpRequest) => void;
  readonly dispatchAckMs?: number;
  readonly failed?: (request: FollowUpRequest) => void;
  readonly isLive?: (request: FollowUpRequest) => boolean;
  /** A dispatched follow-up never started; `retrying` says whether it goes again. */
  readonly lost?: (request: FollowUpRequest, retrying: boolean) => void;
  readonly now?: () => number;
  readonly settled: (request: FollowUpRequest) => void;
  /** A recurring tick lost twice: skip it and keep the cadence. */
  readonly skipped?: (request: FollowUpRequest) => void;
  readonly started: (request: FollowUpRequest) => void;
  readonly unacknowledged?: (request: FollowUpRequest) => void;
  readonly uncertainMaxMs?: number;
}

const DEFAULT_DISPATCH_ACK_MS = 5_000;
/**
 * Pi starts an accepted follow-up before the run that holds it settles. So a
 * session that settles while a dispatch is still unacknowledged has dropped
 * it, for example when the dispatch raced a compaction. An idle session may
 * never settle again, so an unacknowledged dispatch on an idle session is
 * also treated as lost after this long.
 */
const DEFAULT_UNCERTAIN_MAX_MS = 120_000;
/**
 * After compaction outside an agent run, Pi usually starts the prompt that
 * waited behind it: a queued operator message, or the prompt whose
 * pre-flight check compacted after an aborted run. The grace window lets
 * that run claim the session before a held wake starts its own.
 */
const DEFAULT_COMPACTION_GRACE_MS = 5_000;

const contains = (
  context: FollowUpContext,
  request: FollowUpRequest
): boolean =>
  context.active?.dedupeKey === request.dedupeKey ||
  context.queue.some((item) => item.dedupeKey === request.dedupeKey);

const enqueue = (context: FollowUpContext, request: FollowUpRequest) => ({
  queue: contains(context, request)
    ? context.queue
    : [...context.queue, request],
});

const requeueLost = (context: FollowUpContext) => {
  const { active } = context;
  return active === undefined || active.retried === true
    ? { active: undefined }
    : {
        active: undefined,
        queue: [{ ...active, retried: true }, ...context.queue],
      };
};

export const createFollowUpMachine = (ports: FollowUpPorts) => {
  const reportLost = (active: FollowUpRequest | undefined) => {
    if (active === undefined) return;
    const retrying = active.retried !== true;
    ports.lost?.(active, retrying);
    if (retrying) return;
    // A one-shot result has nowhere else to go, so its loss is a failure.
    // A recurring tick is skipped: failing it would end the whole watch.
    if (active.kind === "recurring") ports.skipped?.(active);
    else ports.failed?.(active);
  };

  return setup({
    schemas: {
      context: types<FollowUpContext>(),
      events: {
        COMPACTION_ENDED: types(),
        COMPACTION_STARTED: types(),
        DISPATCH_FAILED: types<{ id: string }>(),
        DROP: types<{ dedupeKey: string }>(),
        ENQUEUE: types<{ request: FollowUpRequest }>(),
        MESSAGE_STARTED: types<{ id: string }>(),
        SESSION_BUSY: types(),
        SESSION_SETTLED: types(),
      },
      input: types<FollowUpMachineInput>(),
    },
    delays: {
      compactionGrace: ports.compactionGraceMs ?? DEFAULT_COMPACTION_GRACE_MS,
      dispatchAck: ports.dispatchAckMs ?? DEFAULT_DISPATCH_ACK_MS,
      uncertainMax: ports.uncertainMaxMs ?? DEFAULT_UNCERTAIN_MAX_MS,
    },
  }).createMachine({
    context: ({ input }) => ({
      compacting: false,
      queue: [],
      sessionBusy: input.sessionBusy,
    }),
    id: "sessionFollowUps",
    initial: "routing",
    on: {
      // Outside idle states, compaction is a fact for the next routing pass.
      COMPACTION_ENDED: () => ({ context: { compacting: false } }),
      COMPACTION_STARTED: () => ({ context: { compacting: true } }),
      DROP: ({ context, event }) => ({
        context: {
          queue: context.queue.filter(
            (request) => request.dedupeKey !== event.dedupeKey
          ),
        },
      }),
    },
    states: {
      awaitingSettlement: {
        on: {
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          SESSION_BUSY: () => ({ context: { sessionBusy: true } }),
          SESSION_SETTLED: ({ context }, enq) => {
            if (context.active !== undefined)
              enq(ports.settled, context.active);
            return {
              context: {
                active: undefined,
                compacting: false,
                sessionBusy: false,
              },
              target: "routing",
            };
          },
        },
      },
      awaitingStart: {
        after: {
          dispatchAck: ({ context }, enq) => {
            const { active } = context;
            if (active !== undefined) {
              enq(() => ports.unacknowledged?.(active));
            }
            return { target: "startUncertain" };
          },
        },
        entry: ({ context }, enq) => {
          const active =
            context.active?.kind === "recurring" && ports.now !== undefined
              ? { ...context.active, dispatchedAt: ports.now() }
              : context.active;
          if (active !== undefined) enq(ports.dispatch, active);
          return { context: { active } };
        },
        on: {
          DISPATCH_FAILED: ({ context, event }, enq) => {
            const { active } = context;
            const matches = active?.id === event.id;
            if (matches) enq(() => ports.failed?.(active));
            return matches
              ? { context: { active: undefined }, target: "routing" }
              : undefined;
          },
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          MESSAGE_STARTED: ({ context, event }, enq) => {
            const { active } = context;
            const matches = active?.id === event.id;
            if (matches) enq(ports.started, active);
            return matches ? { target: "awaitingSettlement" } : undefined;
          },
          SESSION_BUSY: () => ({ context: { sessionBusy: true } }),
        },
      },
      startUncertain: {
        // The cap fires once. A busy run's SESSION_SETTLED decides instead.
        after: {
          uncertainMax: ({ context }, enq) => {
            if (!context.sessionBusy) enq(reportLost, context.active);
            return context.sessionBusy
              ? undefined
              : { context: requeueLost(context), target: "routing" };
          },
        },
        on: {
          DISPATCH_FAILED: ({ context, event }, enq) => {
            const { active } = context;
            const matches = active?.id === event.id;
            if (matches) enq(() => ports.failed?.(active));
            return matches
              ? { context: { active: undefined }, target: "routing" }
              : undefined;
          },
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          MESSAGE_STARTED: ({ context, event }, enq) => {
            const { active } = context;
            const matches = active?.id === event.id;
            if (matches) enq(ports.started, active);
            return matches ? { target: "awaitingSettlement" } : undefined;
          },
          SESSION_BUSY: () => ({ context: { sessionBusy: true } }),
          SESSION_SETTLED: ({ context }, enq) => {
            enq(reportLost, context.active);
            return {
              context: {
                ...requeueLost(context),
                compacting: false,
                sessionBusy: false,
              },
              target: "routing",
            };
          },
        },
      },
      compacting: {
        on: {
          COMPACTION_ENDED: () => ({
            context: { compacting: false },
            target: "compactionGrace",
          }),
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          SESSION_BUSY: () => ({
            context: { sessionBusy: true },
            target: "busy",
          }),
          // A missed compaction-end event must not strand the queue.
          SESSION_SETTLED: () => ({
            context: { compacting: false, sessionBusy: false },
            target: "routing",
          }),
        },
      },
      compactionGrace: {
        after: { compactionGrace: { target: "routing" } },
        on: {
          COMPACTION_STARTED: () => ({
            context: { compacting: true },
            target: "compacting",
          }),
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          SESSION_BUSY: () => ({
            context: { sessionBusy: true },
            target: "busy",
          }),
          SESSION_SETTLED: () => ({
            context: { compacting: false, sessionBusy: false },
            target: "routing",
          }),
        },
      },
      busy: {
        on: {
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
          }),
          SESSION_SETTLED: () => ({
            context: { compacting: false, sessionBusy: false },
            target: "routing",
          }),
        },
      },
      routing: {
        always: ({ context }) => {
          const [head, ...queue] = context.queue;
          if (head !== undefined && !(ports.isLive?.(head) ?? true)) {
            return { context: { queue }, target: "routing" };
          }
          if (context.sessionBusy) return { target: "busy" };
          if (context.compacting) return { target: "compacting" };
          if (head !== undefined) {
            return {
              context: { active: head, queue },
              target: "awaitingStart",
            };
          }
          return { target: "ready" };
        },
      },
      ready: {
        on: {
          COMPACTION_STARTED: () => ({
            context: { compacting: true },
            target: "compacting",
          }),
          ENQUEUE: ({ context, event }) => ({
            context: enqueue(context, event.request),
            target: "routing",
          }),
          SESSION_BUSY: () => ({
            context: { sessionBusy: true },
            target: "busy",
          }),
        },
      },
    },
  });
};

/**
 * Version 1 request from another extension to share this session's arbiter.
 * The caller learns the outcome only through `accept()`: a synchronous call
 * means the request is queued here and the caller must not deliver it itself.
 */
export interface ExternalFollowUpRequest {
  readonly accept: () => void;
  readonly content: string;
  readonly customType: string;
  readonly details: unknown;
  readonly id: string;
  readonly source: string;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const parseExternalFollowUpRequest = (
  value: unknown
): ExternalFollowUpRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.accept !== "function" ||
    !nonEmptyString(record.content) ||
    !nonEmptyString(record.customType) ||
    !nonEmptyString(record.id) ||
    !nonEmptyString(record.source)
  ) {
    return undefined;
  }
  const accept = record.accept as () => void;
  return {
    accept: () => accept(),
    content: record.content,
    customType: record.customType,
    details: record.details,
    id: record.id,
    source: record.source,
  };
};
