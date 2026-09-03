import { assign, setup } from "xstate";

interface FollowUpRequestBase {
  readonly dedupeKey: string;
  readonly id: string;
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
  readonly queue: readonly FollowUpRequest[];
  readonly sessionBusy: boolean;
}

export type FollowUpEvent =
  | { readonly request: FollowUpRequest; readonly type: "ENQUEUE" }
  | { readonly dedupeKey: string; readonly type: "DROP" }
  | { readonly id: string; readonly type: "DISPATCH_FAILED" }
  | { readonly id: string; readonly type: "MESSAGE_STARTED" }
  | { readonly type: "SESSION_BUSY" }
  | { readonly type: "SESSION_SETTLED" };

export interface FollowUpPorts {
  readonly dispatch: (request: FollowUpRequest) => void;
  readonly dispatchAckMs?: number;
  readonly failed?: (request: FollowUpRequest) => void;
  readonly isLive?: (request: FollowUpRequest) => boolean;
  readonly now?: () => number;
  readonly settled: (request: FollowUpRequest) => void;
  readonly started: (request: FollowUpRequest) => void;
  readonly unacknowledged?: (request: FollowUpRequest) => void;
}

const DEFAULT_DISPATCH_ACK_MS = 5_000;

const contains = (
  context: FollowUpContext,
  request: FollowUpRequest
): boolean =>
  context.active?.dedupeKey === request.dedupeKey ||
  context.queue.some((item) => item.dedupeKey === request.dedupeKey);

export const createFollowUpMachine = (ports: FollowUpPorts) =>
  setup({
    actions: {
      activateNext: assign(({ context }) => {
        const [active, ...queue] = context.queue;
        return { active, queue };
      }),
      clearActive: assign({ active: undefined }),
      dispatchActive: ({ context }) => {
        if (context.active !== undefined) ports.dispatch(context.active);
      },
      dropQueueHead: assign({
        queue: ({ context }) => context.queue.slice(1),
      }),
      dropQueued: assign({
        queue: ({ context, event }) =>
          event.type === "DROP"
            ? context.queue.filter(
                (request) => request.dedupeKey !== event.dedupeKey
              )
            : context.queue,
      }),
      enqueue: assign({
        queue: ({ context, event }) =>
          event.type !== "ENQUEUE" || contains(context, event.request)
            ? context.queue
            : [...context.queue, event.request],
      }),
      markSessionBusy: assign({ sessionBusy: true }),
      markSessionIdle: assign({ sessionBusy: false }),
      recordDispatchTime: assign({
        active: ({ context }) => {
          if (context.active?.kind !== "recurring" || ports.now === undefined) {
            return context.active;
          }
          return { ...context.active, dispatchedAt: ports.now() };
        },
      }),
      reportFailure: ({ context }) => {
        if (context.active !== undefined) ports.failed?.(context.active);
      },
      reportSettled: ({ context }) => {
        if (context.active !== undefined) ports.settled(context.active);
      },
      reportStarted: ({ context }) => {
        if (context.active !== undefined) ports.started(context.active);
      },
      reportUnacknowledged: ({ context }) => {
        if (context.active !== undefined) {
          ports.unacknowledged?.(context.active);
        }
      },
    },
    delays: {
      dispatchAck: ports.dispatchAckMs ?? DEFAULT_DISPATCH_ACK_MS,
    },
    guards: {
      hasQueued: ({ context }) => context.queue.length > 0,
      isQueueHeadStale: ({ context }) => {
        const [head] = context.queue;
        return head !== undefined && !(ports.isLive?.(head) ?? true);
      },
      isSessionBusy: ({ context }) => context.sessionBusy,
      matchesActive: ({ context, event }) =>
        (event.type === "DISPATCH_FAILED" ||
          event.type === "MESSAGE_STARTED") &&
        context.active?.id === event.id,
    },
    types: {
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      context: {} as FollowUpContext,
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      events: {} as FollowUpEvent,
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      input: {} as FollowUpMachineInput,
    },
  }).createMachine({
    context: ({ input }) => ({
      queue: [],
      sessionBusy: input.sessionBusy,
    }),
    id: "sessionFollowUps",
    initial: "routing",
    on: {
      DROP: { actions: "dropQueued" },
    },
    states: {
      awaitingSettlement: {
        on: {
          ENQUEUE: { actions: "enqueue" },
          SESSION_BUSY: { actions: "markSessionBusy" },
          SESSION_SETTLED: {
            actions: ["markSessionIdle", "reportSettled", "clearActive"],
            target: "routing",
          },
        },
      },
      awaitingStart: {
        after: {
          dispatchAck: {
            actions: "reportUnacknowledged",
            target: "startUncertain",
          },
        },
        entry: ["recordDispatchTime", "dispatchActive"],
        on: {
          DISPATCH_FAILED: {
            actions: ["reportFailure", "clearActive"],
            guard: "matchesActive",
            target: "routing",
          },
          ENQUEUE: { actions: "enqueue" },
          MESSAGE_STARTED: {
            actions: "reportStarted",
            guard: "matchesActive",
            target: "awaitingSettlement",
          },
          SESSION_BUSY: { actions: "markSessionBusy" },
        },
      },
      startUncertain: {
        on: {
          DISPATCH_FAILED: {
            actions: ["reportFailure", "clearActive"],
            guard: "matchesActive",
            target: "routing",
          },
          ENQUEUE: { actions: "enqueue" },
          MESSAGE_STARTED: {
            actions: "reportStarted",
            guard: "matchesActive",
            target: "awaitingSettlement",
          },
          SESSION_BUSY: { actions: "markSessionBusy" },
        },
      },
      busy: {
        on: {
          ENQUEUE: { actions: "enqueue" },
          SESSION_SETTLED: {
            actions: "markSessionIdle",
            target: "routing",
          },
        },
      },
      routing: {
        always: [
          {
            actions: "dropQueueHead",
            guard: "isQueueHeadStale",
            target: "routing",
          },
          { guard: "isSessionBusy", target: "busy" },
          {
            actions: "activateNext",
            guard: "hasQueued",
            target: "awaitingStart",
          },
          { target: "ready" },
        ],
      },
      ready: {
        on: {
          ENQUEUE: { actions: "enqueue", target: "routing" },
          SESSION_BUSY: { actions: "markSessionBusy", target: "busy" },
        },
      },
    },
  });
