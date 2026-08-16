# pi-until vision

## Who it serves

Pi users and agents that start slow external work and need the same live session to resume when a cheap condition becomes true.

## Outcome

The agent can release its turn, keep working on other requests, and wake with a small completion receipt. No polling loops consume a tool call or model turn.

## Boundaries

- One universal condition: a side-effect-free shell command exits 0.
- Watches belong to one live Pi session/process.
- Agent wake and notification-only completion are both supported.
- Cancellation, per-check timeout, and overall timeout are explicit machine states.
- The extension does not become a daemon, scheduler, workflow engine, or outward notification gateway.
- The extension never claims durability across reloads, session replacement, process exit, or machine reboot.

## Taste

Keep the interface smaller than the problem space. Shell already composes files, HTTP, SSH, PIDs, databases, and scripts. Typed predicate helpers can be sugar later; they must not split the core lifecycle.
