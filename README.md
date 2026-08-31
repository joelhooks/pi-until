# pi-until

A Pi extension for non-blocking shell-condition watches and recurring follow-ups owned by one live Pi session.

For shell watches, **exit code 0 means true**. Pi checks immediately, then polls in the background. When the condition succeeds, the extension can wake the agent with a receipt or only show a notification.

For recurring follow-ups, Pi wakes the same agent every fixed interval with an immutable Markdown task packet. The agent must explicitly complete or cancel the recurrence.

## Why

Long-running work should not pin a tool call, burn model turns, or depend on someone remembering to check a terminal later.

`pi-until` turns this:

```sh
while ! ssh host 'test -f /tmp/done'; do sleep 30; done
```

into a session-owned watch that leaves Pi free for other work.

## Install

```bash
pi install git:github.com/joelhooks/pi-until@main
```

Then restart Pi or run `/reload`.

For local development:

```bash
pi install /Users/joel/Code/joelhooks/pi-until
```

## Agent tool

The extension registers `until` with six actions:

- `start` — begin a background shell-condition watch.
- `repeat` — begin a recurring agent follow-up.
- `list` — list watches in this Pi session.
- `status` — inspect one watch by ID.
- `complete` — mark a recurring watch complete.
- `cancel` — stop a watch without marking it complete.

A `start` call accepts:

- `condition` — side-effect-free shell command; exit 0 means true.
- `label` — short safe name.
- `cwd` — working directory; defaults to Pi's current directory.
- `intervalSeconds` — polling interval; defaults to 30.
- `checkTimeoutSeconds` — limit for one check; defaults to 30.
- `timeoutSeconds` — optional overall deadline.
- `wake` — `agent` or `notify`; defaults to `agent`.

Example intent:

```text
Watch until the remote verification receipt exists, then continue the migration review.
```

Equivalent condition:

```sh
ssh host 'test -f ~/migration/verify.done'
```

A `repeat` call accepts:

- `instruction` — the task given to the agent on every wake.
- `quickRef` — a short human reference for the recurring task.
- `contextRefs` — optional `{ label, target }` pointers. The extension passes them through without resolving them.
- `intervalSeconds` — the fixed cadence.
- `timeoutSeconds` — required absolute lifetime of the recurrence.
- `immediate` — `true` to wake after the current agent turn; otherwise the first wake follows one interval.
- `condition` — optional side-effect-free shell gate. Exit 0 permits that tick to wake the agent. It never completes the recurrence.
- `label` — optional safe display and telemetry label. It defaults to `recurring follow-up`, never to task text.
- `cwd` and `checkTimeoutSeconds` — settings for the optional gate.

```ts
until({
  action: "repeat",
  intervalSeconds: 21_600,
  timeoutSeconds: 86_400,
  instruction: "Review the deployment and fix remaining failures.",
  quickRef: "Release 42 verification",
  contextRefs: [{ label: "Runbook", target: "docs/release.md" }],
  condition: "test -f .deploy-finished",
  immediate: false,
});
```

The extension snapshots `instruction`, `quickRef`, `contextRefs`, and the origin session entry at start. Change the intent by completing or cancelling the old recurrence and starting another one.

Cadence stays anchored to the original schedule. Pi permits at most one pending follow-up. If a task remains unsettled across later ticks, the next receipt reports `missedTicks` instead of stacking agent turns.

## Session display

Active watches appear in a compact card above the editor. Shell watches show check attempts. Recurring watches show deliveries, missed ticks, and whether a follow-up is pending or running. The card disappears when the session has no active watches.

```text
╭─ UNTIL · deploy verification ─────────────────────────╮
│ ◷ next 12s · 2m14s elapsed · 5 checks                 │
╰─ 8f2c1a7d · wakes agent · /until-list ────────────────╯
```

The footer is not used. `/until-list` opens a scrollable session panel with active and finished watches.

## Commands

```text
/until <side-effect-free shell condition>
/until-list
/until-complete <id>
/until-cancel <id>
/until-stats
```

`/until` uses the defaults and wakes the agent when the condition succeeds. `/until-stats` summarizes the local telemetry file.

## Lifecycle

A watch belongs to one live Pi session/process.

- It survives normal agent turns.
- It does not block Pi.
- It survives `/reload`. Pi keeps the process and session alive across a reload and only replaces the extension instance. On `session_shutdown { reason: "reload" }` the extension terminates the in-flight check and writes a versioned watch value to a `pi-until-suspended` session entry. The new instance restores it only on `session_start { reason: "reload" }`. Definitions, task snapshots, counts, the next due time, and the absolute expiry carry over.
- It stops on session switch, fork, `/new`, or Pi shutdown. Graceful shutdown waits for process-tree cleanup before Pi exits. A suspension entry from an earlier process is never resurrected on `resume`.
- It does not survive a machine reboot.
- Print and JSON modes reject new watches because those processes are not durable owners.

This boundary is intentional. `pi-until` is a session primitive, not another scheduler or daemon.

## Telemetry

The extension appends one JSON line per event to `~/.pi/agent/pi-until/events.jsonl`. Nothing leaves the machine. Events: `started`, `finished`, `suspended`, `resumed`, and `action` (tool or command use). A condition is recorded as a 12-character hash plus its first word (for example `test`, `gh`, `curl`); the command text is never written. Recurring instructions and context pointers are never written to telemetry. Labels are written, so keep them safe.

- `PI_UNTIL_TELEMETRY=0` disables it.
- `PI_UNTIL_TELEMETRY_FILE=/path/events.jsonl` moves it.
- `/until-stats` prints counts by status and wake mode, median attempts and duration, reload suspend/resume counts, and the top condition heads.

## Safety

Conditions run through the inherited shell with the same permissions as Pi. The extension discards stdout and stderr. Cancellation and timeouts terminate the condition's process group on macOS and Linux.

Use side-effect-free, idempotent checks. A condition string is arbitrary shell access; installing this extension grants that capability even when Pi's normal bash tool is disabled. Do not put secrets in commands, labels, task snapshots, or context pointers. Recurring task packets remain in the private Pi session, but they are still persisted session data. If the thing needs a durable cross-process owner, use the real workload scheduler instead.

## Development

```bash
npm install
npm run check
npm run pack:dry
```

One XState v5 machine owns shell and recurring lifecycles:

```text
active.routing -> waiting -> checking -----------------> satisfied
       |            |          |                            (shell)
       |            |          +-> duePending
       |            +------------> duePending -> awaitingSettlement
       |                                      -> routing  (recurring)
       +-> completed | expired | cancelled
```

The machine owns cadence, expiry, gate checks, delivery counts, missed ticks, and terminal state. The extension adapts Pi lifecycle events and performs delivery.
