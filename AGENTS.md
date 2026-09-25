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

- `src/command.ts` owns the provider-compatible tool schema, bridge normalization, and one-time parsing into internal commands.
- `src/domain.ts` owns immutable watch definitions, facts, failures, and fixed-cadence math.
- `src/clock.ts` owns the injectable clock port used by machines and tests.
- `src/machine.ts` owns the XState v5 shell and recurring watch lifecycle.
- `src/follow-up.ts` owns the XState v5 session delivery queue, message acknowledgement, settlement, deduplication, and stale-work rejection.
- `src/packet.ts` owns recurring Markdown wake and expiry packets.
- `src/check.ts` owns bounded shell execution and process-group termination.
- `src/completion.ts` owns agent-wake versus notify-only routing.
- `src/suspension.ts` owns the `pi-until-suspended` and `pi-until-resumed` session entries: suspend a watch to a value, parse it back at the boundary, keep the timeout anchored, and decide whether a starting process inherits quit work.
- `src/telemetry.ts` owns local JSONL usage events, condition hashes, and `/until-stats` summaries.
- `extensions/pi-until.ts` owns Pi integration, receipts, UI status, reload and restart suspend/resume, and lifecycle cleanup.
- `tests/fake-pi.ts` is the typed Pi fake. Use it instead of `as unknown as ExtensionAPI` in new tests.
- Tests must exercise transitions, retries, per-check timeout, cancellation, descendant termination, wake behavior, session-wide delivery serialization, the compaction hold, dispatch acknowledgement, recurring coalescing, explicit completion, failure, expiry, reload suspend/resume, and quit-then-relaunch resume.

## Invariants

- Exit code 0 is the only success condition.
- Checks must not overlap for one watch.
- Only one `pi-until` follow-up may be submitted to or running in Pi at a time. Correlate it through `details.followUpId`. Requests other extensions emit on `pi-until:follow-up` join the same queue as terminal follow-ups; `parseExternalFollowUpRequest` validates them, and `accept()` runs only after the request is queued. The extension listens only between `session_start` and `session_shutdown`.
- No follow-up is dispatched between `session_before_compact` and the matching `session_compact` or `session_compact_failed`. After compaction outside an agent run, the arbiter waits a grace window before it dispatches. `agent_settled` also ends the hold, so a missed end event cannot strand the queue. `ctx.isIdle()` is false while Pi compacts, so it must not mark the session busy during a hold.
- Starting a watch returns immediately.
- Cancellation aborts the active check and its descendants on macOS and Linux.
- Condition stdout and stderr are discarded, never added to receipts or model context.
- Session shutdown awaits process-tree cleanup before Pi may exit.
- `session_shutdown { reason: "reload" }` and `{ reason: "quit" }` suspend watches to a version 3 session entry that records the reason and owning session id. Session replacement writes nothing. A print or JSON run writes no quit entry. Every reload and long-lived quit writes an entry, even an empty one, so the newest entry always wins.
- `session_start { reason: "reload" }` resumes the newest entry. `session_start` with reason `startup` or `resume` in a long-lived process resumes the newest entry only when it is an unconsumed quit entry that names this session. A version 2 entry counts only when it is newer than the session header and no message follows it. The resume skips expired, finished, duplicate, and already-active watches, then appends `pi-until-resumed` to consume the entry. `new`, `fork`, a forked copy of a quit entry, and a reload entry resume nothing on startup.
- `/until-resume` is the manual path when automatic recovery did not apply. It uses the same skips and also consumes the entry.
- No durability across a crash, SIGKILL, session replacement, or machine reboot.
- Telemetry never writes condition text or command fragments and never touches the network. It must never throw into a watch.
- Tool parameter schemas must have one `Type.Object` root. Root object unions make the OpenAI Codex bridge serialize arrays, booleans, and numbers as strings.
- `prepareArguments` may repair only known bridge encodings before normal schema validation; malformed values must still fail validation.
- Only `wake=agent` calls `pi.sendMessage(..., { triggerTurn: true })`.
- Never persist or publish secrets from commands or output.
- Do not add a daemon, scheduler, or reboot durability without a separate design decision.

## Agent-facing contract

Keep these surfaces aligned when behavior changes:

- `README.md` explains the user and agent contract.
- `src/command.ts` owns parameter descriptions and boundary parsing.
- `extensions/pi-until.ts` owns the tool description, prompt snippet, and prompt guidelines.
- `src/packet.ts` owns the instructions delivered on wake and expiry.
- `VISION.md` and `.brain/projects/pi-until-reload-survival.svx` hold the durable boundary and its reasons.

Preserve four distinctions in every surface: a gate permits work but does not complete it; dispatch is not acknowledgement; an acknowledgement timeout is uncertain rather than rejected; `/reload` and a graceful quit followed by reopening the same session restore watches automatically, a crash restores nothing unless the operator runs `/until-resume`, and a session replacement, new session, or fork restores nothing.

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
