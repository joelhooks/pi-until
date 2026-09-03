# pi-until vision

## Who it serves

Pi users and agents that need the same live session to resume when a cheap condition becomes true or a recurring task becomes due.

## Outcome

The agent can release its turn, keep working on other requests, and wake with a small receipt. No polling loop consumes a tool call or model turn. A recurring task can return on fixed cadence without stacking follow-up turns or escaping the owning session.

## Boundaries

- One universal shell gate: a side-effect-free command exits 0.
- A recurring wake carries an immutable instruction, quick reference, opaque context pointers, origin entry, and receipt.
- Recurring work ends only through explicit completion, cancellation, failure, or expiry. The shell gate permits a wake; it never completes the work.
- Watches belong to one live Pi session/process. `/reload` keeps both alive, so watches survive it by suspending to a session entry and restarting in the new extension instance.
- Agent wake and notification-only completion are supported for one-shot shell watches. Recurring watches always wake the agent.
- Cancellation, completion, per-check timeout, overall expiry, pending delivery, settlement, and failure are explicit machine states.
- One session arbiter serializes all `pi-until` follow-ups. It correlates dispatch acknowledgement by message ID and waits for the resulting agent turn to settle.
- The extension does not become a daemon, durable scheduler, workflow engine, side-effect runner, or outward notification gateway.
- The extension never claims durability across session replacement, process exit, or machine reboot. A suspension entry written by a dead process is a historical fact, not authority.
- Usage telemetry stays local: a JSONL file under `~/.pi/agent/pi-until/`; only condition hashes are written, never command fragments, recurring instructions, quick references, or context pointers; no network.

## Taste

Keep the interface smaller than the problem space. Shell already composes files, HTTP, SSH, PIDs, databases, and scripts. Typed predicate helpers can be sugar later; they must not split the core lifecycle.
