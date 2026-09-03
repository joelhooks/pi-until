import { assign, fromCallback, fromPromise, setup } from "xstate";

import { systemClock } from "./clock.ts";
import type { UntilClock } from "./clock.ts";
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
  WatchFailure,
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
  | { readonly at: number; readonly type: "DELIVERY_STARTED" }
  | { readonly at: number; readonly type: "DELIVERY_SETTLED" }
  | { readonly failure: WatchFailure; readonly type: "DELIVERY_FAILED" }
  | { readonly at: number; readonly type: "EXPIRE" };

export type WatchTerminalState =
  | "satisfied"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

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
  clock: UntilClock = systemClock
) {
  const now = () => clock.now();
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
      markFinished: assign({
        facts: ({ context }) => ({
          ...context.facts,
          finishedAt: context.facts.finishedAt ?? now(),
        }),
      }),
      markDeliveryFailure: assign({
        facts: ({ context, event }) => ({
          ...context.facts,
          failure:
            event.type === "DELIVERY_FAILED"
              ? event.failure
              : { kind: "delivery", message: "follow-up delivery failed" },
        }),
      }),
      startDelivery: assign({
        facts: ({ context, event }) =>
          afterDeliveryRequested(
            context,
            event.type === "DELIVERY_STARTED" ? event.at : now()
          ),
      }),
      settleDelivery: assign({
        facts: ({ context, event }) =>
          context.definition.kind === "recurring"
            ? coalescePastDue(
                context.facts,
                context.definition.intervalMs,
                event.type === "DELIVERY_SETTLED" ? event.at : now()
              )
            : context.facts,
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
              : clock.setTimeout(
                  () => sendBack({ at: expiresAt, type: "EXPIRE" }),
                  Math.max(0, expiresAt - now())
                );
          return () => {
            if (timer !== undefined) clock.clearTimeout(timer);
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
          DELIVERY_FAILED: {
            actions: "markDeliveryFailure",
            target: "failed",
          },
        },
        states: {
          awaitingSettlement: {
            on: {
              DELIVERY_SETTLED: {
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
                  facts: ({ context, event }) => ({
                    ...context.facts,
                    failure: {
                      kind: "gate" as const,
                      message:
                        event.error instanceof Error
                          ? event.error.message
                          : String(event.error),
                    },
                  }),
                }),
                target: "#watch.failed",
              },
              src: "checkCondition",
            },
          },
          duePending: {
            on: {
              DELIVERY_STARTED: {
                actions: "startDelivery",
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
                guard: ({ context }) => context.facts.deliveryPending,
                target: "duePending",
              },
              { guard: "hasDueGate", target: "checking" },
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
      cancelled: { entry: "markFinished", type: "final" },
      completed: { entry: "markFinished", type: "final" },
      expired: { entry: "markFinished", type: "final" },
      failed: { entry: "markFinished", type: "final" },
      satisfied: { entry: "markFinished", type: "final" },
    },
  });
}
