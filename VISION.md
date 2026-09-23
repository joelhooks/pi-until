# pi-until vision

## Who it serves

Pi users and agents that need the same live session to resume when a cheap condition becomes true or a recurring task becomes due.

## Outcome

The agent can release its turn, keep working on other requests, and wake with a small receipt. No polling loop consumes a tool call or model turn. A recurring task can return on fixed cadence without stacking follow-up turns or escaping the owning session.

## Boundaries

- One universal shell gate: a side-effect-free command exits 0.
- A recurring wake carries an immutable instruction, quick reference, opaque context pointers, origin entry, and receipt.
- Recurring work ends only through explicit completion, cancellation, failure, or expiry. The shell gate permits a wake; it never completes the work.
- Watches belong to one Pi session. `/reload` keeps the session and process alive, so watches survive it by suspending to a session entry and restarting in the new extension instance. A graceful quit hands the same entry to the next process that opens the same session file, and that process restores the watches without an operator command.
- Agent wake and notification-only completion are supported for one-shot shell watches. Recurring watches always wake the agent.
- Cancellation, completion, per-check timeout, overall expiry, pending delivery, settlement, and failure are explicit machine states.
- One session arbiter serializes all `pi-until` follow-ups, including agent wakes another extension hands it through `pi-until:follow-up`. It correlates dispatch acknowledgement by message ID and waits for the resulting agent turn to settle. Sharing the queue does not make pi-until the owner of the other extension's work.
- The extension does not become a daemon, durable scheduler, workflow engine, side-effect runner, or outward notification gateway.
- The extension never claims durability across a crash, SIGKILL, session replacement, a new or forked session, or machine reboot. Only a quit entry that names this session and has not been consumed is authority for a restart. Any other suspension entry is a historical fact. An operator may turn it back into work with `/until-resume`. Once a process resumes an entry, it marks that entry consumed. A later start cannot replay it, so a watch the operator cancelled stays cancelled.
- Usage telemetry stays local: a JSONL file under `~/.pi/agent/pi-until/`; only condition hashes are written, never command fragments, recurring instructions, quick references, or context pointers; no network.

## Taste

Keep the interface smaller than the problem space. Shell already composes files, HTTP, SSH, PIDs, databases, and scripts. Typed predicate helpers can be sugar later; they must not split the core lifecycle.
