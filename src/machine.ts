import { assign, fromCallback, fromPromise, setup } from "xstate";

import {
  advanceAfterTick,
  coalescePastDue,
  expiresAtOf,
  gateOf,
} from "./domain.ts";
import type {
  CheckResult,
  ShellGate,
  WatchActorInput,
  WatchContext,
  WatchFacts,
} from "./domain.ts";

export interface UntilCheckInput {
  readonly command: string;
  readonly cwd: string;
  readonly checkTimeoutMs: number;
}

export type UntilCheckResult = CheckResult;

export type WatchEvent =
  | { readonly type: "CANCEL" }
  | { readonly type: "COMPLETE" }
  | { readonly at: number; readonly type: "EXPIRE" }
  | { readonly type: "SESSION_BUSY" }
  | { readonly at: number; readonly type: "SESSION_SETTLED" };

export type WatchTerminalState =
  | "satisfied"
  | "completed"
  | "expired"
  | "cancelled";

export type RunUntilCheck = (
  input: UntilCheckInput,
  signal: AbortSignal
) => Promise<UntilCheckResult>;

const passed = (result: UntilCheckResult): boolean =>
  result.code === 0 && !result.killed;

const withCheckResult = (
  facts: WatchFacts,
  result: UntilCheckResult,
  checkedAt: number
): WatchFacts => ({
  ...facts,
  lastCheckedAt: checkedAt,
  lastResult: result,
});

const afterNoMatch = (
  context: WatchContext,
  result: UntilCheckResult,
  checkedAt: number
): WatchFacts => {
  const checked = {
    ...withCheckResult(context.facts, result, checkedAt),
    deliveryPending: false,
  };
  return context.definition.kind === "until"
    ? {
        ...checked,
        nextDueAt: checkedAt + context.definition.intervalMs,
      }
    : advanceAfterTick(checked, context.definition.intervalMs, checkedAt);
};

const afterDeliveryRequested = (
  context: WatchContext,
  requestedAt: number,
  result?: UntilCheckResult
): WatchFacts => {
  const checked =
    result === undefined
      ? context.facts
      : withCheckResult(context.facts, result, requestedAt);
  return advanceAfterTick(
    {
      ...checked,
      deliveries: checked.deliveries + 1,
      deliveryPending: false,
    },
    context.definition.intervalMs,
    requestedAt
  );
};

export function createWatchMachine(
  runCheck: RunUntilCheck,
  now: () => number = Date.now
) {
  return setup({
    actions: {
      coalesceAtExpiry: assign({
        facts: ({ context, event }) => {
          if (context.definition.kind !== "recurring") return context.facts;
          const at = event.type === "EXPIRE" ? event.at : now();
          return coalescePastDue(
            context.facts,
            context.definition.intervalMs,
            at
          );
        },
      }),
      countAttempt: assign({
        facts: ({ context }) => ({
          ...context.facts,
          attempts: context.facts.attempts + 1,
        }),
      }),
      markDeliveryPending: assign({
        facts: ({ context }) => ({
          ...context.facts,
          deliveryPending: true,
        }),
      }),
      markSessionBusy: assign({ sessionIdle: false }),
      markSessionIdle: assign({ sessionIdle: true }),
      prepareDelivery: assign({
        facts: ({ context }) => afterDeliveryRequested(context, now()),
      }),
      settleDelivery: assign({
        facts: ({ context, event }) =>
          context.definition.kind === "recurring"
            ? coalescePastDue(
                context.facts,
                context.definition.intervalMs,
                event.type === "SESSION_SETTLED" ? event.at : now()
              )
            : context.facts,
        sessionIdle: true,
      }),
    },
    actors: {
      checkCondition: fromPromise<UntilCheckResult, ShellGate>(
        async ({ input, signal }) => runCheck(input, signal)
      ),
      expiryTimer: fromCallback<WatchEvent, { expiresAt?: number }>(
        ({ input, sendBack }) => {
          const expiresAt = input.expiresAt;
          const timer =
            expiresAt === undefined
              ? undefined
              : setTimeout(
                  () => sendBack({ at: expiresAt, type: "EXPIRE" }),
                  Math.max(0, expiresAt - now())
                );
          return () => {
            if (timer !== undefined) clearTimeout(timer);
          };
        }
      ),
    },
    delays: {
      untilDue: ({ context }) => Math.max(0, context.facts.nextDueAt - now()),
    },
    guards: {
      dueWithoutGate: ({ context }) =>
        context.definition.kind === "recurring" &&
        gateOf(context.definition) === undefined &&
        context.facts.nextDueAt <= now(),
      expired: ({ context }) => {
        const expiresAt = expiresAtOf(context.definition);
        return expiresAt !== undefined && expiresAt <= now();
      },
      hasDueGate: ({ context }) =>
        gateOf(context.definition) !== undefined &&
        context.facts.nextDueAt <= now(),
      isRecurring: ({ context }) => context.definition.kind === "recurring",
      sessionIdle: ({ context }) => context.sessionIdle,
    },
    types: {
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      context: {} as WatchContext,
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      events: {} as WatchEvent,
      // SAFETY: XState reads these empty values only as compile-time type witnesses.
      input: {} as WatchActorInput,
    },
  }).createMachine({
    context: ({ input }) => input,
    id: "watch",
    initial: "active",
    states: {
      active: {
        initial: "routing",
        invoke: {
          id: "expiryTimer",
          input: ({ context }) => ({
            expiresAt: expiresAtOf(context.definition),
          }),
          src: "expiryTimer",
        },
        on: {
          CANCEL: "cancelled",
          COMPLETE: {
            guard: "isRecurring",
            target: "completed",
          },
          EXPIRE: {
            actions: "coalesceAtExpiry",
            target: "expired",
          },
          SESSION_BUSY: { actions: "markSessionBusy" },
          SESSION_SETTLED: { actions: "markSessionIdle" },
        },
        states: {
          awaitingSettlement: {
            on: {
              SESSION_SETTLED: {
                actions: "settleDelivery",
                target: "routing",
              },
            },
          },
          checking: {
            entry: "countAttempt",
            invoke: {
              id: "checkCondition",
              input: ({ context }) => {
                const gate = gateOf(context.definition);
                if (gate === undefined) {
                  throw new Error("checking requires a shell gate");
                }
                return gate;
              },
              onDone: [
                {
                  actions: assign({
                    facts: ({ context, event }) =>
                      withCheckResult(context.facts, event.output, now()),
                  }),
                  guard: ({ context, event }) =>
                    context.definition.kind === "until" && passed(event.output),
                  target: "#watch.satisfied",
                },
                {
                  actions: assign({
                    facts: ({ context, event }) =>
                      afterDeliveryRequested(context, now(), event.output),
                  }),
                  guard: ({ context, event }) =>
                    context.definition.kind === "recurring" &&
                    passed(event.output) &&
                    context.sessionIdle,
                  target: "awaitingSettlement",
                },
                {
                  actions: assign({
                    facts: ({ context, event }) => ({
                      ...withCheckResult(context.facts, event.output, now()),
                      deliveryPending: true,
                    }),
                  }),
                  guard: ({ context, event }) =>
                    context.definition.kind === "recurring" &&
                    passed(event.output),
                  target: "duePending",
                },
                {
                  actions: assign({
                    facts: ({ context, event }) =>
                      afterNoMatch(context, event.output, now()),
                  }),
                  target: "routing",
                },
              ],
              onError: {
                actions: assign({
                  facts: ({ context }) =>
                    afterNoMatch(context, { code: -1, killed: false }, now()),
                }),
                target: "routing",
              },
              src: "checkCondition",
            },
          },
          duePending: {
            on: {
              SESSION_SETTLED: {
                actions: ["markSessionIdle", "prepareDelivery"],
                target: "awaitingSettlement",
              },
            },
          },
          routing: {
            always: [
              {
                actions: "coalesceAtExpiry",
                guard: "expired",
                target: "#watch.expired",
              },
              {
                actions: "prepareDelivery",
                guard: ({ context }) =>
                  context.facts.deliveryPending && context.sessionIdle,
                target: "awaitingSettlement",
              },
              {
                guard: ({ context }) => context.facts.deliveryPending,
                target: "duePending",
              },
              { guard: "hasDueGate", target: "checking" },
              {
                actions: "prepareDelivery",
                guard: ({ context }) =>
                  context.definition.kind === "recurring" &&
                  gateOf(context.definition) === undefined &&
                  context.facts.nextDueAt <= now() &&
                  context.sessionIdle,
                target: "awaitingSettlement",
              },
              {
                actions: "markDeliveryPending",
                guard: "dueWithoutGate",
                target: "duePending",
              },
              { target: "waiting" },
            ],
          },
          waiting: {
            after: { untilDue: "routing" },
          },
        },
      },
      cancelled: { type: "final" },
      completed: { type: "final" },
      expired: { type: "final" },
      satisfied: { type: "final" },
    },
  });
}
