# pi-until agent guide

Owner: flowing-pi desk (Rat King `flowing-pi/flowing-pi-desk`). Bounce questions there.

Read `VISION.md` before changing behavior.

## Commands

```bash
npm install
npm run check
npm run pack:dry
```

Node is `24.18.0` or newer. Maintainers and CI use npm `11.16.0` (the `packageManager` field); any modern npm can install the package, so consumers get no npm pin. Never Bun. Dependencies are exact-pinned.

## Architecture

- `src/command.ts` owns the provider-compatible tool schema, bridge normalization, and one-time parsing into internal commands.
- `src/domain.ts` owns immutable watch definitions, facts, failures, fixed-cadence math, and the per-watch phase and per-tick jitter laid on top of the un-jittered `nextDueAt` anchor.
- `src/clock.ts` owns the injectable clock port used by machines and tests.
- `src/jitter.ts` owns the injectable jitter source. It maps a key to a stable value, so a resumed watch recomputes its due time without persisting it.
- `src/machine.ts` owns the XState v5 shell and recurring watch lifecycle.
- `src/follow-up.ts` owns the XState v5 session delivery queue, message acknowledgement, settlement, deduplication, and stale-work rejection.
- `src/packet.ts` owns recurring Markdown wake and expiry packets.
- `src/check.ts` owns bounded shell execution and process-group termination.
- `src/exit-hooks.ts` owns the process-wide signal/exit registry shared by duplicate package loads and SDK sessions. Signal hooks journal and stop checks; a host settles before publication, or the registry publishes before re-raising an unhandled signal. Signal-exit v3/v4 observers are not host handlers. Keep the shared registry key and shape backward compatible; do not create parallel versioned registries.
- `src/completion.ts` owns agent-wake versus notify-only routing.
- `src/suspension.ts` owns the `pi-until-suspended` and `pi-until-resumed` session entries: suspend a watch to a value, parse it back at the boundary, keep the timeout anchored, and decide whether a starting process inherits quit work.
- `src/handoff.ts` owns private graceful-quit mailboxes, atomic successor claims, bounded event-driven waits, and same-session claim consumption.
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
- Session shutdown marks its boundary before fallible journal I/O and cancels actors even if that I/O fails. Retries use frozen pre-cancellation values. It journals synchronously, then awaits claim/restoration settlement and process-tree cleanup before publishing once. A corrective suspension may supersede the initial journal when ownership settles. Emergency exit can probe completed claims but cannot wait for an in-flight filesystem rename. Mark publication committed at rename, not after directory fsync.
- `session_shutdown { reason: "reload" }` and `{ reason: "quit" }` suspend watches to a version 3 session entry that records the reason and owning session id. Session replacement writes nothing. A print or JSON run writes no quit entry. Normal reloads and long-lived quits write an entry even when empty, so the newest entry wins. A reload interrupting startup restoration retains the original quit entry; see the deferred edge in Brain.
- `session_start { reason: "reload" }` resumes the newest entry. `session_start` with reason `startup` or `resume` in a long-lived process resumes the newest entry only when it is an unconsumed quit entry that names this session. A version 2 entry counts only when it is newer than the session header and no message follows it. The resume skips expired, finished, duplicate, and already-active watches, then appends `pi-until-resumed` to consume the entry. `new`, `fork`, a forked copy of a quit entry, and a reload entry resume nothing on startup.
- `/until-resume` is the manual path when automatic recovery did not apply. It uses the same skips and also consumes the entry.
- Targeted handoff contract and proofs: `.brain/projects/pi-until-reload-survival.svx`; keep prompt surfaces byte-identical to `1d7b250`.
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

Preserve four distinctions in every surface: a gate permits work but does not complete it; dispatch is not acknowledgement; an acknowledgement timeout is uncertain rather than rejected; `/reload` and a graceful quit followed by reopening the same session restore watches automatically, a crash restores nothing unless the operator runs `/until-resume`, and an undeclared session replacement, new session, or fork restores nothing.

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
