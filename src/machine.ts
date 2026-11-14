import { createAsyncLogic, createCallbackLogic, setup, types } from "xstate";

import { systemClock } from "./clock.ts";
import type { UntilClock } from "./clock.ts";
import {
  advanceAfterTick,
  coalescePastDue,
  dueAt,
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
import { systemJitter } from "./jitter.ts";
import type { UntilJitter } from "./jitter.ts";

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
  | { readonly at: number; readonly type: "DELIVERY_SKIPPED" }
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
    ? { ...checked, nextDueAt: checkedAt + context.definition.intervalMs }
    : advanceAfterTick(checked, context.definition.intervalMs, checkedAt);
};

const afterDeliveryRequested = (
  context: WatchContext,
  requestedAt: number
): WatchFacts =>
  advanceAfterTick(
    {
      ...context.facts,
      deliveries: context.facts.deliveries + 1,
      deliveryPending: false,
    },
    context.definition.intervalMs,
    requestedAt
  );

const coalesceAtExpiry = (context: WatchContext, at: number) =>
  context.definition.kind === "recurring"
    ? coalescePastDue(context.facts, context.definition.intervalMs, at)
    : context.facts;

export function createWatchMachine(
  runCheck: RunUntilCheck,
  clock: UntilClock = systemClock,
  jitter: UntilJitter = systemJitter
) {
  const now = () => clock.now();
  const due = (context: WatchContext) =>
    dueAt(context.definition, context.facts, jitter);
  const markFinished = ({ context }: { context: WatchContext }) => ({
    context: {
      facts: {
        ...context.facts,
        finishedAt: context.facts.finishedAt ?? now(),
      },
    },
  });

  return setup({
    schemas: {
      context: types<WatchContext>(),
      events: {
        CANCEL: types(),
        COMPLETE: types(),
        DELIVERY_FAILED: types<{ failure: WatchFailure }>(),
        DELIVERY_SETTLED: types<{ at: number }>(),
        DELIVERY_SKIPPED: types<{ at: number }>(),
        DELIVERY_STARTED: types<{ at: number }>(),
        EXPIRE: types<{ at: number }>(),
      },
      input: types<WatchActorInput>(),
    },
    actors: {
      checkCondition: createAsyncLogic<UntilCheckResult, ShellGate>({
        run: async ({ input, signal }) => runCheck(input, signal),
      }),
      expiryTimer: createCallbackLogic<WatchEvent, { expiresAt?: number }>(
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
      untilDue: ({ context }) => Math.max(0, due(context) - now()),
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
          CANCEL: { target: "cancelled" },
          COMPLETE: ({ context }) =>
            context.definition.kind === "recurring"
              ? { target: "completed" }
              : undefined,
          EXPIRE: ({ context, event }) => ({
            context: { facts: coalesceAtExpiry(context, event.at) },
            target: "expired",
          }),
          DELIVERY_FAILED: ({ context, event }) => ({
            context: { facts: { ...context.facts, failure: event.failure } },
            target: "failed",
          }),
        },
        states: {
          awaitingSettlement: {
            on: {
              DELIVERY_SETTLED: ({ context, event }) => ({
                context: {
                  facts:
                    context.definition.kind === "recurring"
                      ? coalescePastDue(
                          context.facts,
                          context.definition.intervalMs,
                          event.at
                        )
                      : context.facts,
                },
                target: "routing",
              }),
            },
          },
          checking: {
            entry: ({ context }) => ({
              context: {
                facts: {
                  ...context.facts,
                  attempts: context.facts.attempts + 1,
                },
              },
            }),
            invoke: {
              id: "checkCondition",
              input: ({ context }) => {
                const gate = gateOf(context.definition);
                if (gate === undefined) {
                  throw new Error("checking requires a shell gate");
                }
                return gate;
              },
              onDone: ({ context, event }) => {
                if (passed(event.output)) {
                  const facts = withCheckResult(
                    context.facts,
                    event.output,
                    now()
                  );
                  return context.definition.kind === "until"
                    ? { context: { facts }, target: "#watch.satisfied" }
                    : {
                        context: { facts: { ...facts, deliveryPending: true } },
                        target: "duePending",
                      };
                }
                return {
                  context: {
                    facts: afterNoMatch(context, event.output, now()),
                  },
                  target: "routing",
                };
              },
              onError: ({ context, event }) => ({
                context: {
                  facts: {
                    ...context.facts,
                    failure: {
                      kind: "gate",
                      message:
                        event.error instanceof Error
                          ? event.error.message
                          : String(event.error),
                    },
                  },
                },
                target: "#watch.failed",
              }),
              src: "checkCondition",
            },
          },
          duePending: {
            on: {
              DELIVERY_STARTED: ({ context, event }) => ({
                context: { facts: afterDeliveryRequested(context, event.at) },
                target: "awaitingSettlement",
              }),
              DELIVERY_SKIPPED: ({ context, event }) => ({
                context: {
                  facts:
                    context.definition.kind === "recurring"
                      ? advanceAfterTick(
                          {
                            ...context.facts,
                            deliveryPending: false,
                            missedTicks: context.facts.missedTicks + 1,
                          },
                          context.definition.intervalMs,
                          event.at
                        )
                      : context.facts,
                },
                target: "routing",
              }),
            },
          },
          routing: {
            // v6 evaluates `always` twice. Keep it pure; enqueue any effects.
            always: ({ context }) => {
              const expiresAt = expiresAtOf(context.definition);
              if (expiresAt !== undefined && expiresAt <= now()) {
                return {
                  context: { facts: coalesceAtExpiry(context, now()) },
                  target: "#watch.expired",
                };
              }
              if (context.facts.deliveryPending)
                return { target: "duePending" };
              if (due(context) <= now()) {
                if (gateOf(context.definition) !== undefined) {
                  return { target: "checking" };
                }
                if (context.definition.kind === "recurring") {
                  return {
                    context: {
                      facts: { ...context.facts, deliveryPending: true },
                    },
                    target: "duePending",
                  };
                }
              }
              return { target: "waiting" };
            },
          },
          waiting: {
            after: {
              untilDue: { target: "routing" },
            },
          },
        },
      },
      cancelled: { entry: markFinished, type: "final" },
      completed: { entry: markFinished, type: "final" },
      expired: { entry: markFinished, type: "final" },
      failed: { entry: markFinished, type: "final" },
      satisfied: { entry: markFinished, type: "final" },
    },
  });
}
