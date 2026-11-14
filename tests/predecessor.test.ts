import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, SimulatedClock } from "xstate";

import {
  claimHandoff,
  completeHandoff,
  DEFAULT_HANDOFF_WAIT_MS,
  predecessorLiveness,
  prepareHandoff,
  publishHandoff,
  publishHandoffSync,
  writeSessionLiveness,
} from "../src/handoff.ts";
import {
  createDeathGraceMachine,
  DEFAULT_DEATH_GRACE_MS,
  processStartTime,
  linuxProcessStart,
} from "../src/predecessor.ts";
import type { ProcessStart, ProcessStartProbe } from "../src/predecessor.ts";
import { suspensionData } from "../src/suspension.ts";

const roots: string[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const directoryFor = async () => {
  const directory = await mkdtemp(join(tmpdir(), "until-liveness-"));
  roots.push(directory);
  return directory;
};
const startTime = "2026-11-14T01:02:03.000Z";
const present: ProcessStart = { kind: "present", startTime };
const record = async (directory: string) => {
  await writeSessionLiveness(directory, "parent", async () => present);
};
const claim = (directory: string, probe: ProcessStartProbe, extra = {}) => {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    result: claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: controller.signal,
      processStart: probe,
      deathGraceMs: 20,
      waitMs: 100,
      ...extra,
    }),
  };
};

it("parses Linux field 22 independently of wall-clock fields and complex comm names", () => {
  const boot = "12345678-1234-1234-1234-123456789abc";
  const procStat = `123 (a ) tricky name) S ${Array.from({ length: 18 }, () => "0").join(" ")} 987654321 99`;
  expect(linuxProcessStart(procStat, boot)).toEqual({
    kind: "present",
    startTime: `linux:${boot}:987654321`,
  });
  expect(linuxProcessStart(procStat.replace(" 0 0", " 999 888"), boot)).toEqual(
    linuxProcessStart(procStat, boot)
  );
  expect(
    linuxProcessStart(procStat.replace("987654321", "987654322"), boot)
  ).not.toEqual(linuxProcessStart(procStat, boot));
  expect(linuxProcessStart("invalid", boot)).toEqual({ kind: "unknown" });
});

it("treats a pre-upgrade Linux wall-clock identity as unknown, not reused", async () => {
  const directory = await directoryFor();
  await record(directory);
  expect(
    await predecessorLiveness(directory, "parent", async () => ({
      kind: "present",
      startTime: "linux:12345678-1234-1234-1234-123456789abc:123",
    }))
  ).toBe("unknown");
});

it("does not treat an invalid ISO identity record as death", async () => {
  const directory = await directoryFor();
  await record(directory);
  await writeFile(
    join(directory, "liveness", "parent.json"),
    JSON.stringify({
      sessionId: "parent",
      pid: process.pid,
      startTime: "2026-99-14T01:02:03.000Z",
    })
  );
  expect(
    await predecessorLiveness(directory, "parent", async () => present)
  ).toBe("unknown");
});

describe("process identity records", () => {
  it("writes only owner-private identity metadata atomically", async () => {
    const directory = await directoryFor();
    await record(directory);
    const path = join(directory, "liveness", "parent.json");
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({
      sessionId: "parent",
      pid: process.pid,
      startTime,
    });
    const file = await stat(path);
    const folder = await stat(join(directory, "liveness"));
    expect(file.mode % 0o1000).toBe(0o600);
    expect(folder.mode % 0o1000).toBe(0o700);
    expect(await readdir(join(directory, "liveness"))).toEqual(["parent.json"]);
  });
  it.each([
    [present, "alive"],
    [{ kind: "missing" }, "gone"],
    [{ kind: "present", startTime: "2026-11-14T01:02:04.000Z" }, "gone"],
    [{ kind: "unknown" }, "unknown"],
  ] satisfies readonly [ProcessStart, string][])(
    "compares the recorded identity: %j",
    async (observed, expected) => {
      const directory = await directoryFor();
      await record(directory);
      expect(
        await predecessorLiveness(directory, "parent", async () => observed)
      ).toBe(expected);
    }
  );
  it("never calls a process probe without a valid record", async () => {
    const directory = await directoryFor();
    const probe = vi
      .fn<ProcessStartProbe>()
      .mockResolvedValue({ kind: "missing" });
    expect(await predecessorLiveness(directory, "parent", probe)).toBe(
      "unrecorded"
    );
    await mkdir(join(directory, "liveness"), { mode: 0o700 });
    await writeFile(join(directory, "liveness", "parent.json"), "{bad json", {
      mode: 0o600,
    });
    expect(await predecessorLiveness(directory, "parent", probe)).toBe(
      "unknown"
    );
    await writeFile(
      join(directory, "liveness", "parent.json"),
      JSON.stringify({ sessionId: "other", pid: process.pid, startTime })
    );
    expect(await predecessorLiveness(directory, "parent", probe)).toBe(
      "unknown"
    );
    expect(probe).not.toHaveBeenCalled();
  });
  it("treats a failed process probe as unknown", async () => {
    const directory = await directoryFor();
    await record(directory);
    expect(
      await predecessorLiveness(directory, "parent", async () => {
        throw new Error("unavailable");
      })
    ).toBe("unknown");
  });
  it.each([false, true])(
    "removes its record only after publication (sync: %s)",
    async (sync) => {
      const directory = await directoryFor();
      await record(directory);
      const data = suspensionData([], Date.now(), "quit", "parent");
      if (sync) publishHandoffSync(directory, prepareHandoff(data));
      else await publishHandoff(directory, data);
      expect(
        JSON.parse(await readFile(join(directory, "parent.json"), "utf-8"))
      ).toHaveProperty("sessionId", "parent");
      await expect(
        stat(join(directory, "liveness", "parent.json"))
      ).rejects.toHaveProperty("code", "ENOENT");
    }
  );
  it("does not remove a different process's identity record", async () => {
    const directory = await directoryFor();
    await record(directory);
    const path = join(directory, "liveness", "parent.json");
    await writeFile(
      path,
      JSON.stringify({ sessionId: "parent", pid: process.pid + 1, startTime })
    );
    await publishHandoff(
      directory,
      suspensionData([], Date.now(), "quit", "parent")
    );
    expect(await stat(path)).toBeDefined();
  });
  it("reads a stable real OS start time without argv", async () => {
    const first = await processStartTime(process.pid);
    expect(first.kind).toBe("present");
    expect(await processStartTime(process.pid)).toEqual(first);
    expect(await processStartTime(2_147_483_647)).toEqual({ kind: "missing" });
  });
});

describe("death grace lifecycle", () => {
  it("requires continuous conclusive death and resets on alive or unknown", () => {
    const clock = new SimulatedClock();
    const elapsed = vi.fn();
    const actor = createActor(
      createDeathGraceMachine(DEFAULT_DEATH_GRACE_MS, () => {
        elapsed();
      }),
      { clock }
    ).start();
    actor.send({ type: "OBSERVED", state: "unknown" });
    clock.increment(DEFAULT_HANDOFF_WAIT_MS);
    expect(elapsed).not.toHaveBeenCalled();
    for (const state of ["alive", "unknown"] as const) {
      actor.send({ type: "OBSERVED", state: "gone" });
      clock.increment(DEFAULT_DEATH_GRACE_MS - 1);
      expect(elapsed).not.toHaveBeenCalled();
      actor.send({ type: "OBSERVED", state });
      clock.increment(DEFAULT_DEATH_GRACE_MS);
      expect(actor.getSnapshot().value).toBe("waiting");
    }
    actor.send({ type: "OBSERVED", state: "gone" });
    clock.increment(DEFAULT_DEATH_GRACE_MS);
    expect(actor.getSnapshot().value).toBe("verify");
    expect(elapsed).toHaveBeenCalledOnce();
    actor.stop();
  });
  it.each([
    { kind: "missing" },
    { kind: "present", startTime: "2026-11-14T01:02:04.000Z" },
  ] satisfies ProcessStart[])(
    "releases for a dead or reused pid after the grace: %j",
    async (identity) => {
      const directory = await directoryFor();
      await record(directory);
      const probe = vi.fn<ProcessStartProbe>().mockResolvedValue(identity);
      const { result } = claim(directory, probe, { waitMs: 500 });
      await expect(result).resolves.toEqual({
        kind: "released",
        reason: "predecessor-gone",
      });
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
  );
  it.each([present, { kind: "unknown" }] satisfies ProcessStart[])(
    "does not release a live or inconclusive predecessor: %j",
    async (identity) => {
      const directory = await directoryFor();
      await record(directory);
      await expect(
        claim(directory, async () => identity).result
      ).resolves.toEqual({ kind: "empty" });
    }
  );
  it.each([present, { kind: "unknown" }] satisfies ProcessStart[])(
    "rechecks identity after the grace: %j",
    async (identity) => {
      const directory = await directoryFor();
      await record(directory);
      const probe = vi
        .fn<ProcessStartProbe>()
        .mockResolvedValue(identity)
        .mockResolvedValueOnce({ kind: "missing" });
      await expect(claim(directory, probe).result).resolves.toEqual({
        kind: "empty",
      });
      expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
  );
  it("keeps the 30-minute default ceiling without a record", async () => {
    const directory = await directoryFor();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const probe = vi
      .fn<ProcessStartProbe>()
      .mockResolvedValue({ kind: "missing" });
    const { controller, result } = claim(directory, probe, {
      waitMs: undefined,
    });
    try {
      await vi.waitFor(() =>
        expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30 * 60_000)
      );
      expect(probe).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await expect(result).resolves.toEqual({ kind: "aborted" });
      timeout.mockRestore();
    }
  });
  it.each([false, true])(
    "does not release work already claimed elsewhere (receipted: %s)",
    async (receipted) => {
      const directory = await directoryFor();
      const data = suspensionData([], Date.now(), "quit", "parent");
      await publishHandoff(directory, {
        ...data,
        terminalFollowUps: [
          {
            kind: "terminal",
            id: "delivery",
            watchId: "watch",
            dedupeKey: "watch",
            customType: "test",
            content: "test",
            details: {},
          },
        ],
      });
      const other = await claimHandoff({
        directory,
        predecessorId: "parent",
        successorId: "holder",
        signal: new AbortController().signal,
      });
      if (other.kind !== "claimed") throw new Error("missing competing claim");
      if (receipted)
        await completeHandoff({
          directory,
          predecessorId: "parent",
          successorId: "holder",
          handoff: other.handoff,
        });
      const timeout = vi.fn();
      const { controller, result } = claim(
        directory,
        async () => ({ kind: "missing" }),
        {
          waitMs: 20,
          passive: true,
          onTimeout: (watching: boolean) => {
            timeout(watching);
          },
        }
      );
      await expect(result).resolves.toEqual({ kind: "claimed-elsewhere" });
      expect(timeout).not.toHaveBeenCalled();
      controller.abort();
    }
  );

  it("honors abort while ownership evidence is being classified", async () => {
    const directory = await directoryFor();
    await mkdir(join(directory, "claimed"));
    await writeFile(
      join(directory, "claimed", "parent!other.json"),
      "invalid JSON"
    );
    const controller = new AbortController();
    controllers.push(controller);
    const warn = vi.fn(() => controller.abort());
    const result = await claimHandoff({
      directory,
      predecessorId: "parent",
      successorId: "child",
      signal: controller.signal,
      waitMs: 1,
      passive: true,
      warn,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ownership evidence is unavailable")
    );
    expect(result).toEqual({ kind: "aborted" });
  });

  it("adopts a publication arriving after death detection but inside the grace", async () => {
    const directory = await directoryFor();
    await record(directory);
    const probe = vi
      .fn<ProcessStartProbe>()
      .mockResolvedValue({ kind: "missing" });
    const { result } = claim(directory, probe, {
      deathGraceMs: 10_000,
      waitMs: 1_000,
    });
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    const data = suspensionData([], Date.now(), "quit", "parent");
    await publishHandoff(directory, {
      ...data,
      terminalFollowUps: [
        {
          kind: "terminal",
          id: "delivery",
          watchId: "watch",
          dedupeKey: "watch",
          customType: "test",
          content: "test",
          details: {},
        },
      ],
    });
    await expect(result).resolves.toHaveProperty("kind", "claimed");
  });
});
