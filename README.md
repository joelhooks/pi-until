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

## Choose the primitive

| Need | Use |
| --- | --- |
| Resume when a cheap fact becomes true | `action: "start"` |
| Ask the same agent to do work on a fixed cadence with ±10% jitter and a stable per-watch phase | `action: "repeat"` |
| Survive Pi exit, session replacement, or reboot | Use a durable workload scheduler instead |

A shell condition is a predicate, not a job. If the command changes the system, it does not belong in `pi-until`.

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
- `list` — list watches in this Pi session. While a successor waits for handoff, it also shows pending ids, labels, watch deadlines, and the handoff deadline from its fork snapshot. These are not active watches yet; do not re-arm them. If the snapshot has no inventory, the pending predecessor remains visible.
- `status` — inspect one watch by ID.
- `complete` — mark a recurring watch complete.
- `cancel` — stop a watch without marking it complete.

A `start` call accepts:

- `condition` — side-effect-free shell command; exit 0 means true.
- `label` — short safe name.
- `cwd` — working directory; defaults to Pi's current directory.
- `intervalSeconds` — polling interval; defaults to 30. After the immediate first check, each check runs within ±10% of one interval after the last.
- `checkTimeoutSeconds` — limit for one check; defaults to 30.
- `timeoutSeconds` — optional overall deadline.
- `wake` — `agent` or `notify`; defaults to `agent`.
- `jitter` — `false` to check on exact intervals; defaults to `true`.

Example intent:

```text
Watch until the remote verification receipt exists, then continue the migration review.
```

Equivalent condition:

```sh
ssh host 'test -f ~/migration/verify.done'
```

Write conditions that fail closed. Exit 0 must prove the thing happened, not that nothing went wrong. pi-until checks immediately, so a condition that exits 0 on missing input wakes the agent with a false success on check 1:

- An empty or missing script can exit 0. Gate on the evidence it produces instead: `grep -qx READY out.txt`, `test -s result.json`.
- A pipeline exits with its last command's status, so a pipeline ending in a command that always succeeds proves nothing: `grep done log | wc -l` exits 0 even when it counts zero. Gate on the test itself: `grep -q done log`.
- A negation such as `! pgrep -f job` is true before the job starts. Pair it with positive evidence that the job ran, such as its output file.
- Prove the evidence is fresh. A previous run's `results.txt` or a dead process's pid file makes `test -s results.txt` or `! kill -0 $(cat pid)` true before this run does anything. Clear old output first, or check for a marker unique to this run.
- Do not arm a watch in the same tool batch that writes, moves, or resets anything its condition reads. Parallel calls can run the first check before that call lands.
- For result streams, persist consumed item IDs or a source cursor before re-arming. The new predicate must reject handled results. A new watch ID or a later timestamp does not make an old item unhandled. Use a stable item identity or source sequence; an update timestamp can change on an already-handled item.

A `repeat` call accepts:

- `instruction` — the task given to the agent on every wake.
- `quickRef` — a short human reference for the recurring task.
- `contextRefs` — optional `{ label, target }` pointers. The extension passes them through without resolving them.
- `intervalSeconds` — the fixed cadence, with ±10% jitter and a stable per-watch phase.
- `timeoutSeconds` — required absolute lifetime of the recurrence.
- `immediate` — `true` to wake after the current agent turn; otherwise the first wake follows one interval plus the watch's phase.
- `jitter` — `false` for exact cadence with no phase or jitter; defaults to `true`.
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

Cadence stays anchored to the original schedule. Watches started together would otherwise stay aligned and fire on the same second, so the schedule spreads them two ways. Each recurrence gets a stable phase from its watch ID, between 0 and 20% of the interval, added to the first wake: `start + interval + phase`. Every later tick then moves by up to ±10% of the interval around its anchor. Jitter never accumulates: the anchor advances by exactly one interval, missed-tick counts use the anchor, and a resumed watch recomputes the same due time. `immediate: true` still wakes after the current turn. `jitter: false` restores exact times. Watches saved before jitter existed resume with jitter on.

One session-wide arbiter sends only one `pi-until` follow-up into Pi at a time. It waits for Pi to start that exact message and for the resulting agent turn to settle before it sends another. Missed ticks increase `missedTicks` instead of stacking agent turns. If acknowledgement takes more than five seconds, the arbiter pauses and warns instead of guessing that Pi discarded an accepted message. A late `message_start` resumes the lifecycle safely. A synchronous dispatch rejection fails the recurring watch.

The arbiter never sends a follow-up while Pi compacts the session outside an agent run, such as a manual `/compact`. Pi starts an extension-triggered turn even while it compacts, and that turn races the summarizer on the uncompacted context. Checks keep running during compaction; a wake that comes due waits. When compaction ends or fails, the arbiter waits five more seconds so a prompt queued behind compaction starts first, then delivers. Compaction inside an agent run needs no hold because the run already owns the session.

## Agent contract

Reading a finished watch with `status` or `cancel` drops only that watch's queued terminal wake; `list` does not consume wakes, and already dispatched wakes still settle normally.

- Treat `contextRefs` as opaque pointers. Read a target only when the instruction requires it.
- Call `complete` only when the recurring goal is achieved. A finished turn is not a finished recurrence.
- Call `cancel` when the recurrence should stop without success.
- An expired or failed receipt is terminal. Do not continue its instruction unless the user asks.
- A successful shell receipt proves the condition was true when checked, not that work remains when the wake arrives. Check whether the task is finished or the matching result was already handled. Skip handled results; re-arm only when the monitoring task continues, after recording consumption and excluding those results.

## Session display

Active watches appear in a compact card above the editor. Shell watches show check attempts. Recurring watches show deliveries, missed ticks, and whether a follow-up is pending or running. The card disappears when the session has no active watches.

```text
╭─ UNTIL · deploy verification ─────────────────────────╮
│ ◷ next 12s · 2m14s elapsed · 5 checks                 │
╰─ 8f2c1a7d · wakes agent · /until-list ────────────────╯
```

The footer is not used. `/until-list` opens a scrollable session panel with active and finished watches.

Other extensions can follow active watches on `pi.events`. Whenever the visible list changes (a watch starts, ticks, finishes, or is cancelled), the full list is emitted on `pi-until:watches`, including an empty list when the last watch finishes. Refreshes that change nothing do not emit.

```ts
pi.events.on("pi-until:watches", (watches) => {
  // [{ id, label, kind, status, wake, startedAt, nextDueAt, attempts, ... }]
});
```

## Sharing the follow-up queue

Another extension can hand an agent wake to the same session arbiter, so only one follow-up from either extension is submitted or running at a time. Emit a version 1 request on `pi-until:follow-up`:

```ts
let accepted = false;
pi.events.emit("pi-until:follow-up", {
  version: 1,
  source: "bellwether",       // non-empty; namespaces the dedupe key
  id: "batch-7",              // non-empty and unique per request from this source
  customType: "bellwether-wakes",
  content: "2 Bellwether waits settled. ...",
  details: { wakes: [...] },   // delivered as details.receipt
  accept: () => { accepted = true; },
});
if (!accepted) pi.sendMessage(/* deliver it yourself */);
```

`accept()` runs synchronously when pi-until queued the request. The caller must then not deliver it again. pi-until does not accept before `session_start`, during or after `session_shutdown`, or when the request is malformed; the caller keeps ownership in those cases. Pi receives the message with `details: { followUpId, receipt: details }` and `triggerTurn: true`, and the arbiter waits for that turn to settle before the next follow-up. An acknowledgement timeout pauses the queue exactly as it does for pi-until's own follow-ups.

## Commands

```text
/until <side-effect-free shell condition>
/until-list
/until-complete <id>
/until-cancel <id>
/until-stats
/until-resume
```

`/until` uses the defaults and wakes the agent when the condition succeeds. `/until-stats` summarizes the local telemetry file.

## Lifecycle

A watch belongs to one live Pi session/process.

- It survives normal agent turns.
- It does not block Pi.
- It survives `/reload`. Pi keeps the process and session alive across a reload and only replaces the extension instance. On `session_shutdown { reason: "reload" }` the extension terminates the in-flight check and writes a versioned watch value to a `pi-until-suspended` session entry. The new instance restores it only on `session_start { reason: "reload" }`. Definitions, task snapshots, counts, the next due time, and the absolute expiry carry over.
- It survives a graceful quit and relaunch of the same session. On `session_shutdown { reason: "quit" }` (Ctrl+D, `/quit`, SIGTERM, SIGHUP) the extension writes the same entry and records `reason: "quit"` and the owning session id. When a long-lived Pi process opens that session file again (`pi -c`, `pi --session <file>`, or `/resume` to it), `session_start` with reason `startup` or `resume` restores the watches with no command. Watches whose absolute expiry passed while Pi was closed, watches that later wrote a finished receipt, duplicate ids, and ids already active are skipped. A recurring watch whose tick came due while Pi was closed fires once with `missedTicks` counted and stays on its original cadence. The extension then appends a `pi-until-resumed` entry, so no later start can replay the same quit entry.
- It stops on `/new`, fork, or switching away from the session. Session replacement writes no entry, and an undeclared new or forked session inherits nothing, including a fork that copied the parent's quit entry. Explicit successor startup is the exception below. Graceful shutdown waits for process-tree cleanup before Pi exits.
- It also saves quit work on SIGHUP, SIGTERM, and Pi's dead-terminal exit (129), even when the terminal disappears before `session_shutdown` can run. Suspension is synchronous and precedes cleanup awaits. Signal hooks journal and kill this extension's running shell process groups. If Pi handles the signal, publication waits for its shutdown settlement or exit hook. Without a host handler, one process-wide hook publishes all loaded instances before re-raising the signal. Normal shutdown can append a corrective suspension after a pending claim or ownership check settles; the newest entry wins, and the handoff is published once.
- Exit hooks synchronously inspect completed claims and foreign ownership receipts. They cannot await a filesystem rename still in flight when the process exits. That emergency window remains a limit, not a durability guarantee. An emergency exit during `/reload` retains the reload entry; it does not promote it to automatic quit recovery. Use `/until-resume` when reopening that session if needed.
- If a host catches a signal and keeps running, pi-until stays stopped until reload. After five seconds it records one `signal-held` telemetry event per stopped session; `/until-stats` reports that the host held the signal for ≥5 s, even if it subsequently exits. The callback never writes to a possibly dead terminal. The process registry distinguishes real host handlers from signal-exit's v3/v4 default-exit observers, so those observers cannot swallow an otherwise unhandled signal.
- A failed graceful-quit journal has no guaranteed exit-time retry: Pi makes its extension context stale before process exit. Inspect the shutdown and published-or-not notices and the private error log. Reopen the session and use `/until-resume` for available saved work; it cannot recover a suspension that was never written.
- Persistence failures in exit hooks append a private `persistence-errors.jsonl` file in the handoff directory when storage allows. It contains only the time, session id and error code, never commands or error messages. Startup maintenance removes it after the handoff retention period (seven days by default) or above 64 KiB. A successful mailbox rename is a committed publication even if directory fsync fails; the notice distinguishes that uncertainty from a failed publication, and the mailbox is never published twice.
- It does not survive an unrelated crash, SIGKILL, or a machine reboot. Those create no new quit authority. A reload entry is never treated as quit work.
- `/until-resume` is the manual path when automatic recovery did not apply, for example after a crash that left only a reload entry. It reads the newest suspension entry with the same skips and marks it consumed. Manual wake recovery is at-least-once: delivered/consumed request ids recorded on the current branch are skipped, but an unacknowledged start may duplicate.
- Print and JSON modes reject new watches because those processes are not durable owners. A print or JSON run of a session neither restores its watches nor writes a quit entry, so it cannot bury a pending one.
- Entries written by `0.5.0` carry no reason. A `0.5.0` quit entry is restored only when it is newer than the session header and no conversation message follows it.

This boundary is intentional. `pi-until` is a session primitive, not another scheduler or daemon.

## Successor handoff

A graceful successor needs `PI_UNTIL_SUCCESSOR_ID` matching its session id; `PI_UNTIL_SUCCEEDS` (or `RATKING_SUCCEEDS`) only names the predecessor. Without a target there is no adoption; re-arm manually. Even undeclared sessions write a bounded private file per graceful quit, perform asynchronous filesystem work before restoration, gate reopen on mailbox ownership, recover pending wakes on quit only, and journal handled wake ids; quit does not increment reload counts. Stale own files are cleared and journalled, freshness uses only pi-until's causal markers, and restart chains follow up to three predecessors. A refused reopen durably consumes its own quit entry. After the visible wait, a passive filesystem watcher remains until shutdown. Status and `until list` show it. `until list` includes a separate `handoffPending` detail with the predecessor, deadline, phase, and advisory watch inventory from the fork snapshot. That inventory is not restoration authority; only the claimed handoff can start watches. Uncertain and manual wake recovery is at-least-once. V3 watch journals remain rollback-readable; wakes and transfer metadata have separate entries. See [the durable lifecycle contract](.brain/projects/pi-until-reload-survival.svx) for retention, limits, and the zero-model-call proof.

## Telemetry

The extension appends one JSON line per event to `~/.pi/agent/pi-until/events.jsonl`. Nothing leaves the machine. Events: `started`, `finished`, `suspended`, `resumed`, and `action` (tool or command use). A condition is recorded only as a 12-character hash; no command fragment is written. Recurring instructions, quick references, and context pointers are never written to telemetry. Labels are written, so keep them safe.

- `PI_UNTIL_TELEMETRY=0` disables it.
- `PI_UNTIL_TELEMETRY_FILE=/path/events.jsonl` moves it.
- `/until-stats` prints counts by status and wake mode, median attempts and duration, and reload suspend/resume counts.
- `/until-resume` resumes watches from the newest suspension entry when automatic restart recovery did not apply.

## Safety

Conditions run through the inherited shell with the same permissions as Pi. The extension discards stdout and stderr. Cancellation and timeouts terminate the condition's process group on macOS and Linux.

Use side-effect-free, idempotent checks. A condition string is arbitrary shell access; installing this extension grants that capability even when Pi's normal bash tool is disabled. Do not put secrets in commands, labels, task snapshots, or context pointers. Recurring task packets remain in the private Pi session, but they are still persisted session data. If the thing needs a durable cross-process owner, use the real workload scheduler instead.

## Development

```bash
npm install
npm run check
npm run pack:dry
```

One XState v6 machine owns each watch:

```text
active.routing -> waiting -> checking -----------------> satisfied
       |            |          |                            (shell)
       |            |          +-> duePending
       |            +------------> duePending -> awaitingSettlement
       |                                      -> routing  (recurring)
       +-> completed | expired | cancelled | failed
```

A second XState v6 machine owns the session delivery queue:

```text
ready -> queued -> awaiting message_start -> awaiting agent_settled -> ready
```

`src/command.ts` parses the flat provider schema once into an internal command. The watch machine owns cadence, expiry, checks, delivery counts, missed ticks, and terminal state. The session queue owns cross-watch serialization, message correlation, deduplication, dispatch acknowledgement, and the compaction hold. The extension only adapts these parts to Pi lifecycle events, receipts, and UI.
