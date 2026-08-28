# pi-until agent guide

Read `VISION.md` before changing behavior.

## Commands

```bash
npm install
npm run check
npm run pack:dry
```

Node is `24.18.0`. Use npm `11.16.0`; never Bun. `devEngines` fails hard on any other npm; if the machine has a newer npm, run the binaries from `node_modules/.bin` directly (`tsc --noEmit`, `ultracite check`, `oxfmt --check`, `vitest run`) and say so. Dependencies are exact-pinned.

## Architecture

- `src/machine.ts` owns the XState v5 watch lifecycle.
- `src/check.ts` owns bounded shell execution and process-group termination.
- `src/completion.ts` owns agent-wake versus notify-only routing.
- `src/suspension.ts` owns the `pi-until-suspended` session entry: suspend a watch to a value, parse it back at the boundary, keep the timeout anchored.
- `src/telemetry.ts` owns local JSONL usage events, the condition hash/head, and `/until-stats` summaries.
- `extensions/pi-until.ts` owns Pi integration, receipts, UI status, reload suspend/resume, and lifecycle cleanup.
- `tests/fake-pi.ts` is the typed Pi fake. Use it instead of `as unknown as ExtensionAPI` in new tests.
- Tests must exercise transitions, retries, per-check timeout, cancellation, descendant termination, wake behavior, and reload suspend/resume.

## Invariants

- Exit code 0 is the only success condition.
- Checks must not overlap for one watch.
- Starting a watch returns immediately.
- Cancellation aborts the active check and its descendants on macOS and Linux.
- Condition stdout and stderr are discarded, never added to receipts or model context.
- Session shutdown awaits process-tree cleanup before Pi may exit.
- Only `session_shutdown { reason: "reload" }` suspends watches, and only `session_start { reason: "reload" }` resumes them. Every reload writes a suspension entry, even an empty one, so the newest entry always wins.
- Telemetry never writes condition text and never touches the network. It must never throw into a watch.
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
