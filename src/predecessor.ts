import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { setup, types } from "xstate";

export type ProcessStart =
  | { readonly kind: "present"; readonly startTime: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

export type ProcessStartProbe = (pid: number) => Promise<ProcessStart>;
export type PredecessorLiveness = "alive" | "gone" | "unknown" | "unrecorded";
export type HandoffReleaseReason = "predecessor-gone" | "deadline-no-record";
export const DEFAULT_DEATH_GRACE_MS = 10_000;

// oxlint-disable-next-line typescript/strict-void-return -- Node's promisify accepts execFile's unused ChildProcess return.
const execute = promisify(execFile);

/** Field 22 is relative to boot, unaffected by Linux realtime clock steps. */
export const linuxProcessStart = (
  stat: string,
  bootId: string
): ProcessStart => {
  if (!/^\d+ \(/u.test(stat) || stat.lastIndexOf(")") < 2)
    return { kind: "unknown" };
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u)[19];
  return /^\d+$/u.test(ticks ?? "") &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(bootId.trim())
    ? { kind: "present", startTime: `linux:${bootId.trim()}:${ticks}` }
    : { kind: "unknown" };
};
const linuxProbe: ProcessStartProbe = async (pid) => {
  try {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf-8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf-8"),
    ]);
    return linuxProcessStart(stat, boot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try {
        process.kill(pid, 0);
      } catch (signalError) {
        if (
          signalError instanceof Error &&
          "code" in signalError &&
          signalError.code === "ESRCH"
        )
          return { kind: "missing" };
      }
    }
    return { kind: "unknown" };
  }
};

/** No argv scan: Pi's process title can hide a live session's arguments. */
export const processStartTime: ProcessStartProbe = async (pid) => {
  if (process.platform === "linux") return linuxProbe(pid);
  try {
    const { stdout } = await execute(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf-8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        maxBuffer: 1024,
        timeout: 1_000,
      }
    );
    const time = Date.parse(`${stdout.trim()} UTC`);
    return Number.isFinite(time)
      ? { kind: "present", startTime: new Date(time).toISOString() }
      : { kind: "unknown" };
  } catch (error) {
    // A failed ps is not death. Confirm an empty, unsuccessful lookup with
    // ESRCH; permission, executable and transport failures remain unknown.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stdout" in error &&
      error.stdout === "" &&
      "stderr" in error &&
      error.stderr === ""
    ) {
      try {
        process.kill(pid, 0);
      } catch (signalError) {
        if (
          signalError instanceof Error &&
          "code" in signalError &&
          signalError.code === "ESRCH"
        ) {
          return { kind: "missing" };
        }
      }
    }
    return { kind: "unknown" };
  }
};

/** Eligibility only: the caller must recheck identity and claim before release. */
export const createDeathGraceMachine = (
  graceMs: number,
  onElapsed: () => void
) =>
  setup({
    schemas: {
      events: { OBSERVED: types<{ state: PredecessorLiveness }>() },
    },
    delays: { deathGrace: graceMs },
  }).createMachine({
    initial: "waiting",
    states: {
      waiting: {
        on: {
          OBSERVED: ({ event }) =>
            event.state === "gone" ? { target: "grace" } : {},
        },
      },
      grace: {
        after: { deathGrace: { target: "verify" } },
        on: {
          OBSERVED: ({ event }) =>
            event.state === "gone" ? {} : { target: "waiting" },
        },
      },
      verify: {
        entry: (_, enq) => {
          enq(onElapsed);
        },
        on: {
          OBSERVED: ({ event }) =>
            event.state === "gone" ? {} : { target: "waiting" },
        },
      },
    },
  });
