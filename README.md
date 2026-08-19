# pi-until

A Pi extension that watches a shell condition without blocking the agent turn.

The condition is simple: **exit code 0 means true**. Pi checks immediately, then polls in the background. When the condition succeeds, the extension can wake the agent with a receipt or only show a notification.

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

The extension registers `until` with four actions:

- `start` — begin a background watch.
- `list` — list watches in this Pi session.
- `status` — inspect one watch by ID.
- `cancel` — stop one watch by ID.

A start call accepts:

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

## Session display

Active watches appear in a compact card above the editor. The card shows the label, current check phase, elapsed time, attempt count, and next check time. It disappears when the session has no active watches.

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
/until-cancel <id>
```

`/until` uses the defaults and wakes the agent when the condition succeeds.

## Lifecycle

A watch belongs to one live Pi session/process.

- It survives normal agent turns.
- It does not block Pi.
- It stops on `/reload`, session switch, fork, or Pi shutdown. Graceful shutdown waits for process-tree cleanup before Pi exits.
- It does not survive a machine reboot.
- Print and JSON modes reject new watches because those processes are not durable owners.

This boundary is intentional. `pi-until` is a session primitive, not another scheduler or daemon.

## Safety

Conditions run through the inherited shell with the same permissions as Pi. The extension discards stdout and stderr. Cancellation and timeouts terminate the condition's process group on macOS and Linux.

Use side-effect-free, idempotent checks. A condition string is arbitrary shell access; installing this extension grants that capability even when Pi's normal bash tool is disabled. Do not put secrets in commands or labels. If the thing needs a durable cross-process owner, use the real workload scheduler instead.

## Development

```bash
npm install
npm run check
npm run pack:dry
```

The lifecycle is an XState v5 machine:

```text
running.checking -> running.sleeping -> running.checking
        |                    |
        +-> succeeded        +-> timedOut
        +----------------------> cancelled
```
