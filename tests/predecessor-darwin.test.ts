import type * as ChildProcess from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processStartTime } from "../src/predecessor.ts";

const execute = vi.hoisted(() =>
  vi.fn<() => Promise<{ stdout: string; stderr: string }>>()
);
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }),
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (platform === undefined) throw new Error("missing platform descriptor");
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  execute.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

const lookupError = (overrides: object = {}) =>
  Object.assign(new Error("ps lookup"), {
    code: 1,
    stdout: "",
    stderr: "",
    ...overrides,
  });
const missingPid = () =>
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });

describe("Darwin process probe ambiguity", () => {
  it("requires a clean absent lookup and ESRCH before reporting missing", async () => {
    execute.mockRejectedValue(lookupError());
    const kill = missingPid();
    expect(await processStartTime(12345)).toEqual({ kind: "missing" });
    expect(kill).toHaveBeenCalledExactlyOnceWith(12345, 0);
  });

  it.each([
    { stderr: "ps: process id too large: 2147483647\n" },
    { stderr: "ps: permission denied\n" },
    { stdout: "unexpected output\n" },
    { code: 2 },
    { code: "ENOENT" },
    { code: null, killed: true, signal: "SIGTERM" },
  ])("keeps unsuccessful ambiguous ps output unknown: %j", async (failure) => {
    execute.mockRejectedValue(lookupError(failure));
    const kill = missingPid();
    expect(await processStartTime(12345)).toEqual({ kind: "unknown" });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(["EPERM", "EACCES", "EINVAL"])(
    "keeps signal-zero %s unknown",
    async (code) => {
      execute.mockRejectedValue(lookupError());
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("signal unavailable"), { code });
      });
      expect(await processStartTime(12345)).toEqual({ kind: "unknown" });
    }
  );

  it("keeps a successful signal-zero check unknown when ps cannot identify the live process", async () => {
    execute.mockRejectedValue(lookupError());
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(await processStartTime(12345)).toEqual({ kind: "unknown" });
  });

  it.each(["", "not a date", "ps: unavailable"])(
    "keeps malformed successful output unknown: %j",
    async (stdout) => {
      execute.mockResolvedValue({ stdout, stderr: "" });
      const kill = missingPid();
      expect(await processStartTime(12345)).toEqual({ kind: "unknown" });
      expect(kill).not.toHaveBeenCalled();
    }
  );

  it("keeps a valid live start time present", async () => {
    execute.mockResolvedValue({
      stdout: "Sat Nov 14 01:02:03 2026\n",
      stderr: "",
    });
    const kill = missingPid();
    expect(await processStartTime(12345)).toEqual({
      kind: "present",
      startTime: "2026-11-14T01:02:03.000Z",
    });
    expect(kill).not.toHaveBeenCalled();
  });
});
