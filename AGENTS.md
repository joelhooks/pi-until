# pi-until agent guide

Read `VISION.md` before changing behavior.

## Commands

```bash
npm install
npm run check
npm run pack:dry
```

Node is `24.18.0`. Use npm `11.16.0`; never Bun. Dependencies are exact-pinned.

## Architecture

- `src/machine.ts` owns the XState v5 watch lifecycle.
- `src/check.ts` owns bounded shell execution and process-group termination.
- `src/completion.ts` owns agent-wake versus notify-only routing.
- `extensions/pi-until.ts` owns Pi integration, receipts, UI status, and lifecycle cleanup.
- Tests must exercise transitions, retries, per-check timeout, cancellation, descendant termination, and wake behavior.

## Invariants

- Exit code 0 is the only success condition.
- Checks must not overlap for one watch.
- Starting a watch returns immediately.
- Cancellation aborts the active check and its descendants on macOS and Linux.
- Condition stdout and stderr are discarded, never added to receipts or model context.
- Session shutdown awaits process-tree cleanup before Pi may exit.
- Only `wake=agent` calls `pi.sendMessage(..., { triggerTurn: true })`.
- Never persist or publish secrets from commands or output.
- Do not add a daemon, scheduler, or reboot durability without a separate design decision.

## Sources

Pi extension behavior must be checked against the maintained source mirror in the Dark Wizard repo:

```text
/Users/joel/Code/joelhooks/dark-wizard/.agent_sources/github.com/earendil-works/pi-mono
```

Relevant upstream files:

- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/packages.md`
- `packages/coding-agent/examples/extensions/file-trigger.ts`
- `packages/coding-agent/src/core/extensions/types.ts`

The mirror metadata records the exact upstream commit. Refresh it before relying on stale APIs.
