import { assign, fromPromise, setup } from "xstate";

export interface UntilCheckInput {
  readonly command: string;
  readonly cwd: string;
  readonly checkTimeoutMs: number;
}

export interface UntilCheckResult {
  readonly code: number;
  readonly killed: boolean;
}

export interface UntilInput extends UntilCheckInput {
  readonly id: string;
  readonly label: string;
  readonly intervalMs: number;
  readonly timeoutMs?: number;
  readonly wake: "agent" | "notify";
  readonly startedAt: number;
}

export interface UntilContext extends UntilInput {
  readonly attempts: number;
  readonly lastCheckedAt?: number;
  readonly lastResult?: UntilCheckResult;
}

export type UntilEvent =
  | { readonly type: "CANCEL" }
  | { readonly type: "TIMEOUT" };

export type UntilTerminalState = "succeeded" | "timedOut" | "cancelled";

export type RunUntilCheck = (
  input: UntilCheckInput,
  signal: AbortSignal
) => Promise<UntilCheckResult>;

export function createUntilMachine(runCheck: RunUntilCheck) {
  return setup({
    actions: {
      countAttempt: assign({
        attempts: ({ context }) => context.attempts + 1,
      }),
    },
    actors: {
      checkCondition: fromPromise<UntilCheckResult, UntilCheckInput>(
        async ({ input, signal }) => runCheck(input, signal)
      ),
    },
    delays: {
      pollInterval: ({ context }) => context.intervalMs,
    },
    types: {},
  }).createMachine({
    context: ({ input }) => ({ ...input, attempts: 0 }),
    id: "until",
    initial: "running",
    states: {
      cancelled: { type: "final" },
      running: {
        initial: "checking",
        on: {
          CANCEL: "cancelled",
          TIMEOUT: "timedOut",
        },
        states: {
          checking: {
            entry: "countAttempt",
            invoke: {
              input: ({ context }) => ({
                command: context.command,
                cwd: context.cwd,
                checkTimeoutMs: context.checkTimeoutMs,
              }),
              onDone: [
                {
                  guard: ({ event }) =>
                    event.output.code === 0 && !event.output.killed,
                  target: "#until.succeeded",
                  actions: assign({
                    lastCheckedAt: () => Date.now(),
                    lastResult: ({ event }) => event.output,
                  }),
                },
                {
                  target: "sleeping",
                  actions: assign({
                    lastCheckedAt: () => Date.now(),
                    lastResult: ({ event }) => event.output,
                  }),
                },
              ],
              onError: {
                actions: assign({
                  lastCheckedAt: () => Date.now(),
                  lastResult: () => ({
                    code: -1,
                    killed: false,
                  }),
                }),
                target: "sleeping",
              },
              src: "checkCondition",
            },
          },
          sleeping: {
            after: {
              pollInterval: "checking",
            },
          },
        },
      },
      succeeded: { type: "final" },
      timedOut: { type: "final" },
    },
  });
}
