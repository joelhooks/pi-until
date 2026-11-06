// Zero-model-call proof through the supplied real Pi launcher.
// Run: node tests/live-handoff.mjs <p9-launcher> [distill|restart|race|late|binding|reload|reload-claim|untargeted|stale|chain|sigkill]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** @typedef {{type: string, id?: string, success?: boolean, method?: string, message?: string, statusKey?: string, statusText?: string}} RpcRecord */
/** @typedef {{type: string, id?: string, customType?: string, data: {watches?: import('../src/suspension.ts').PersistedWatch[], suspendedAt?: string, resumed?: number, intended?: number, pendingPredecessor?: {predecessorId: string, notBefore: string}, predecessorId?: string, transferId?: string}}} ProofEntry */
/** @typedef {{result: {content: {text: string}[], details: {watches: import('../extensions/pi-until.ts').WatchReceipt[]}}, entries: ProofEntry[], phaseOffsets: {id: string, phase: number}[]}} ProofArtifact */
/** @typedef {{sessionId: string, sessionFile: string, reason: string, startedAt: number, parentSession?: string, parentEnvId?: string, declarationCleared: boolean, inheritedScope?: string, scope?: string}} Ready */
/** @typedef {{exitCode: number, agentStarts: number}} RawProof */
/** @returns {Promise<RawProof>} Receipt written after the actual raw-spawn child exits. */
const readRawProof = async (path) => JSON.parse(await readFile(path, "utf-8"));

// SAFETY: these isolated fixture serializers write the exact shapes declared above.
/** @returns {Promise<ProofArtifact>} The fixture's receipts and branch entries. */
const readArtifact = async (path) => JSON.parse(await readFile(path, "utf-8"));
/** @returns {Promise<Ready>} The observed real session_start event and header. */
const readReady = async (path) => JSON.parse(await readFile(path, "utf-8"));
/** @returns {Promise<ProofEntry[]>} Entries from the real test session file. */
const readEntries = async (path) => {
  const text = await readFile(path, "utf-8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
};

/** @param {ProofEntry[]} entries Entries from one real test session. */
const newestSuspensionEntry = (entries) => {
  let newest;
  for (const entry of entries)
    if (entry.type === "custom" && entry.customType === "pi-until-suspended")
      newest = entry;
  return newest;
};

const root = await mkdtemp(join(tmpdir(), "pi-until-live-handoff-"));
const home = join(root, "home");
const repo = resolvePath(import.meta.dirname, "..");
const launcher = process.argv[2];
assert.ok(launcher, "Pass the installed p9 launcher path");
// p9's shell launcher locates its immutable installation through HOME. These
// test-only symlinks expose code, not operator settings, credentials or sessions.
await mkdir(join(home, ".local", "share", "fnm", "aliases"), {
  recursive: true,
});
await symlink(
  join(homedir(), ".local", "share", "fnm", "aliases", "default"),
  join(home, ".local", "share", "fnm", "aliases", "default")
);
await symlink(
  join(homedir(), ".local", "share", "pi-candidates"),
  join(home, ".local", "share", "pi-candidates")
);
const mailbox = join(home, ".pi", "agent", "pi-until", "handoff");
const foreignFixture = join(root, "foreign-extension.ts");
await writeFile(
  foreignFixture,
  `export default function(pi) {
  pi.on("session_start", (event) => pi.appendEntry("foreign-startup", { reason: event.reason }));
  pi.on("session_shutdown", (event) => { if (event.reason === "quit") pi.appendEntry("foreign-shutdown", { fixture: true }); });
}`
);
const fixture = join(root, "fixture.ts");
await writeFile(
  fixture,
  `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import piUntil from ${JSON.stringify(join(repo, "extensions/pi-until.ts"))};
import { newestSuspension } from ${JSON.stringify(join(repo, "src/suspension.ts"))};
import { phaseOffsetMs } from ${JSON.stringify(join(repo, "src/domain.ts"))};
export default function(pi) {
  const inheritedScope = process.env.PI_UNTIL_SCOPE;
  let execute;
  // Only capture the registered execute for no-model harness commands. All
  // lifecycle, environment, storage and session APIs below are real Pi APIs.
  piUntil({ ...pi, appendEntry(type, data) { if (process.env.HARNESS_INTERRUPT && type === "pi-until-suspension-extra" && data.handoff) throw new Error("injected pre-journal interruption"); pi.appendEntry(type, data); }, registerTool(definition) { execute = definition.execute; pi.registerTool(definition); } });
  pi.on("session_start", (event, ctx) => {
    writeFileSync(process.env.HARNESS_OUTPUT + ".ready", JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), reason: event.reason, startedAt: Date.now(), parentSession: ctx.sessionManager.getHeader()?.parentSession, parentEnvId: process.env.PI_SESSION_ID, declarationCleared: !process.env.PI_UNTIL_SUCCESSOR_ID && !process.env.PI_UNTIL_SUCCEEDS, inheritedScope, scope: process.env.PI_UNTIL_SCOPE }));
  });
  pi.registerCommand("handoff-proof", { description: "Inert harness commands; never calls a model", handler: async (action, ctx) => {
    if (action === "reload") { delete process.env.HARNESS_INTERRUPT; await ctx.reload(); return; }
    if (action === "spawn-raw") {
      // Deliberately forward process.env, without Pi bash's session stamp.
      const output = process.env.HARNESS_OUTPUT + ".raw";
      const child = spawn(process.env.HARNESS_LAUNCHER, ["--mode", "rpc", "--fork", ctx.sessionManager.getSessionFile(), "--session-id", randomUUID(), "--session-dir", ${JSON.stringify(join(root, "sessions"))}, "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", ${JSON.stringify(fixture)}], { cwd: ctx.cwd, env: { ...process.env, HARNESS_OUTPUT: output }, stdio: ["pipe", "pipe", "pipe"] });
      const records = [];
      await new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("raw child timeout")); }, 15000);
        child.stderr.on("data", () => {});
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\\n"); buffer = lines.pop() ?? "";
          for (const line of lines) {
            const record = JSON.parse(line); records.push(record);
            if (record.type !== "response") continue;
            if (!record.success) { child.stdin.end(); reject(new Error("raw child command failed")); }
            else if (record.id === "raw-state") child.stdin.write(JSON.stringify({ type: "prompt", id: "raw-list", message: "/handoff-proof list" }) + "\\n");
            else if (record.id === "raw-list") child.stdin.end();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          writeFileSync(output + ".proof", JSON.stringify({ exitCode: code, agentStarts: records.filter((record) => record.type === "agent_start").length }));
          if (code === 0) resolve(); else reject(new Error("raw child exit " + code));
        });
        child.stdin.write(JSON.stringify({ type: "get_state", id: "raw-state" }) + "\\n");
      });
      return;
    }
    const call = (args) => execute("harness", args, new AbortController().signal, undefined, ctx);
    if (action === "arm") {
      const sleeping = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error("initial gates did not settle")); }, 10000);
        const off = pi.events.on("pi-until:watches", (watches) => {
          if (watches.length === 3 && watches.every((watch) => watch.phase === "sleeping")) { clearTimeout(timer); off(); resolve(); }
        });
      });
      await call({ action: "start", condition: ${JSON.stringify(`test -f ${join(root, "never-a")}`)}, intervalSeconds: 300, timeoutSeconds: 3600 });
      await call({ action: "start", condition: ${JSON.stringify(`test -f ${join(root, "never-b")}`)}, intervalSeconds: 300, timeoutSeconds: 3600 });
      await call({ action: "repeat", condition: ${JSON.stringify(`test -f ${join(root, "never-repeat")}`)}, intervalSeconds: 300, timeoutSeconds: 3600, instruction: "Inspect only fresh harness records", quickRef: "cursor:42", contextRefs: [{label: "cursor", target: "opaque:42"}] });
      await sleeping;
    }
    const result = await call({ action: "list" });
    const entries = ctx.sessionManager.getBranch();
    const suspended = newestSuspension(entries);
    const phaseOffsets = (suspended?.watches ?? []).map((watch) => ({ id: watch.facts.id, phase: phaseOffsetMs(watch.definition, watch.facts.id) }));
    writeFileSync(process.env.HARNESS_OUTPUT, JSON.stringify({ result, entries, phaseOffsets }));
  } });
}
`
);

/** @type {import('node:child_process').ChildProcessWithoutNullStreams[]} */
const processes = [];
/**
 * @param {string} name Isolated process label.
 * @param {string} cwd Test working directory.
 * @param {string[]} sessionArgs Session launch arguments.
 * @param {Record<string, string>} declaration Explicit launch environment.
 */
const launch = (name, cwd, sessionArgs, declaration = {}) => {
  const output = join(root, name);
  const coLoaded = name.startsWith("distill-");
  const argv = [
    "--mode",
    "rpc",
    ...sessionArgs,
    "--session-dir",
    join(root, "sessions"),
    ...(coLoaded ? [] : ["--no-extensions"]),
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "-e",
    fixture,
    ...(coLoaded ? ["-e", foreignFixture] : []),
  ];
  const child = spawn(launcher, argv, {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TERM: "dumb",
      PI_UNTIL_TELEMETRY: "0",
      HARNESS_OUTPUT: output,
      HARNESS_LAUNCHER: launcher,
      ...declaration,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  processes.push(child);
  let buffer = "";
  /** @type {Map<string | undefined, (record: RpcRecord) => void>} */
  const pending = new Map();
  /** @type {RpcRecord[]} */
  const records = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const record = JSON.parse(line);
      records.push(record);
      if (record.type === "response") pending.get(record.id)?.(record);
    }
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  let sequence = 0;
  const command = (type, extra = {}) =>
    new Promise((resolve, reject) => {
      sequence += 1;
      const id = `${name}-${sequence}`;
      const deadline = setTimeout(
        () => reject(new Error(`RPC timeout ${type}: ${diagnostics}`)),
        20_000
      );
      pending.set(id, (record) => {
        clearTimeout(deadline);
        pending.delete(id);
        if (record.success) resolve(record);
        else reject(new Error(JSON.stringify(record)));
      });
      child.stdin.write(`${JSON.stringify({ type, id, ...extra })}\n`);
    });
  const close = async () => {
    const exited = once(child, "exit");
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, diagnostics);
  };
  const inspect = async () => {
    await command("prompt", { message: "/handoff-proof list" });
    return readArtifact(output);
  };
  const crash = async () => {
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  };
  return { child, output, records, command, close, crash, inspect, argv };
};

/** @param {ReturnType<typeof launch>[]} candidates Real successors waiting for the same predecessor. */
const waitForAdoption = async (candidates, fragment = "resumed 3 watches") => {
  const winner = () =>
    candidates.find((candidate) =>
      candidate.records.some(
        (record) =>
          record.type === "extension_ui_request" &&
          record.method === "notify" &&
          record.message?.includes(fragment)
      )
    );
  if (winner()) return winner();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const candidate of candidates)
        candidate.child.stdout.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("No adoption event"));
    }, 20_000);
    const onData = () => {
      const adopted = winner();
      if (adopted) {
        clearTimeout(timer);
        cleanup();
        resolve(adopted);
      }
    };
    for (const candidate of candidates)
      candidate.child.stdout.on("data", onData);
    onData();
  });
};

/** @param {{kind: string, parent: ReturnType<typeof launch>, parentReady: Ready, child: ReturnType<typeof launch>, ready: Ready, armed: ProofArtifact}} input Isolated no-adoption proof state. */
const proveNoAdoption = async (input) => {
  const { kind, parent, parentReady, child, ready, armed } = input;
  if (kind === "sigkill") {
    await parent.crash();
    await waitForAdoption([child], "nothing to adopt");
    const view = await child.inspect();
    assert.equal(view.result.details.watches.length, 0);
    assert.ok(
      view.result.content[0].text.includes("watching for a late handoff")
    );
    let status;
    for (const record of child.records)
      if (
        record.method === "setStatus" &&
        record.statusKey === "pi-until-handoff"
      )
        status = record;
    assert.ok(status?.statusText?.includes("watching for a late handoff"));
    await assert.rejects(
      readFile(join(mailbox, `${parentReady.sessionId}.json`)),
      { code: "ENOENT" }
    );
  } else {
    await parent.close();
    const view = await child.inspect();
    assert.equal(view.result.details.watches.length, 0);
    assert.ok(!view.result.content[0].text.includes("handoff:"));
    assert.ok(
      await readFile(join(mailbox, `${parentReady.sessionId}.json`), "utf-8")
    );
  }
  await child.close();
  assert.equal(
    [parent, child]
      .flatMap((process) => process.records)
      .filter((record) => record.type === "agent_start").length,
    0
  );
  return {
    kind,
    parentId: parentReady.sessionId,
    successorReasons: [ready.reason],
    sessionFiles: [parentReady.sessionFile, ready.sessionFile],
    ids: armed.result.details.watches.map((watch) => watch.id),
    adoptionCount: 0,
    expectedAdoptions: 0,
    watchAdoptions: 0,
    passiveWatch: kind === "sigkill",
    predecessorSignal: parent.child.signalCode,
    paidCalls: 0,
    exitCodes: [parent.child.exitCode, child.child.exitCode],
  };
};

/** @param {{parent: ReturnType<typeof launch>, parentReady: Ready, second: ReturnType<typeof launch>, secondReady: Ready, cwd: string, armed: ProofArtifact}} input Isolated chained-restart proof state. */
const proveChain = async (input) => {
  const { parent, parentReady, second, secondReady, cwd, armed } = input;
  const snapshot = join(cwd, "third-snapshot.jsonl");
  await copyFile(secondReady.sessionFile, snapshot);
  const thirdId = randomUUID();
  const third = launch(
    "chain-c",
    cwd,
    ["--fork", snapshot, "--session-id", thirdId],
    { RATKING_SUCCEEDS: secondReady.sessionId, PI_UNTIL_SUCCESSOR_ID: thirdId }
  );
  await third.command("get_state");
  const ready = await readReady(`${third.output}.ready`);
  assert.equal(ready.reason, "startup");
  await second.close();
  await waitForAdoption([third], `predecessor ${parentReady.sessionId}`);
  const pending = await third.inspect();
  assert.ok(
    pending.result.content[0].text.includes(
      `waiting for ${parentReady.sessionId}`
    )
  );
  await parent.close();
  await waitForAdoption([third]);
  const result = await third.inspect();
  assert.deepEqual(
    result.result.details.watches.map((watch) => watch.id).sort(),
    armed.result.details.watches.map((watch) => watch.id).sort()
  );
  for (const watch of result.result.details.watches) {
    const original = armed.result.details.watches.find(
      (item) => item.id === watch.id
    );
    assert.ok(original);
    assert.equal(watch.nextDueAt, original.nextDueAt);
    assert.equal(watch.expiresAt, original.expiresAt);
    assert.equal(watch.reloads, 0);
  }
  await third.close();
  const entries = await readEntries(ready.sessionFile);
  const markers = entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "pi-until-resumed"
  );
  assert.deepEqual(
    markers.map((entry) => entry.data.predecessorId),
    [secondReady.sessionId, parentReady.sessionId]
  );
  assert.deepEqual(
    markers.map((entry) => entry.data.resumed),
    [0, 3]
  );
  const all = [parent, second, third];
  assert.equal(
    all
      .flatMap((process) => process.records)
      .filter((record) => record.type === "agent_start").length,
    0
  );
  assert.ok(all.every((process) => process.child.exitCode === 0));
  return {
    kind: "chain",
    parentId: parentReady.sessionId,
    successorReasons: [secondReady.reason, ready.reason],
    sessionFiles: [
      parentReady.sessionFile,
      secondReady.sessionFile,
      ready.sessionFile,
    ],
    ids: result.result.details.watches.map((watch) => watch.id),
    adoptionCount: 2,
    expectedAdoptions: 2,
    watchAdoptions: 1,
    predecessorChain: [secondReady.sessionId, parentReady.sessionId],
    paidCalls: 0,
    exitCodes: all.map((process) => process.child.exitCode),
  };
};

/** @param {{kind: string, source: string, snapshot: string}} input Derived distill fixture input. */
const addDistillSummary = async (input) => {
  if (input.kind !== "distill") return;
  const original = await readEntries(input.source);
  assert.ok(
    original.some(
      (entry) =>
        entry.type === "custom" && entry.customType === "foreign-shutdown"
    )
  );
  const core = newestSuspensionEntry(original);
  assert.ok(core);
  const last = original.at(-1);
  assert.ok(last?.id);
  // Append only to this derived fixture input; the real parent file stays intact.
  const summaryTimestamp = new Date().toISOString();
  assert.ok(core.data.suspendedAt);
  assert.ok(Date.parse(summaryTimestamp) > Date.parse(core.data.suspendedAt));
  await appendFile(
    input.snapshot,
    `${JSON.stringify({ type: "compaction", id: "distiller-summary", parentId: last.id, timestamp: summaryTimestamp, summary: "Isolated distiller-stamped summary fixture", firstKeptEntryId: "seed", tokensBefore: 1 })}\n`
  );
};

const runCase = async (kind) => {
  const cwd = join(root, kind);
  await mkdir(cwd, { recursive: true });
  const parentId = randomUUID();
  const seed = join(cwd, "parent.jsonl");
  const timestamp = new Date().toISOString();
  // A conversation fixture makes Pi persist real files without a model call.
  const fixtureEntries = [
    { type: "session", version: 3, id: parentId, cwd, timestamp },
    {
      type: "message",
      id: "seed",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: "Isolated inert-gate harness fixture",
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(
    seed,
    `${fixtureEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
  let parent = launch(`${kind}-a`, cwd, ["--session", seed]);
  const earlier = [];
  await parent.command("get_state");
  let parentReady = await readReady(`${parent.output}.ready`);
  let staleTombstone;
  if (kind === "stale") {
    await parent.close();
    staleTombstone = await readFile(join(mailbox, `${parentId}.json`), "utf-8");
    assert.equal(JSON.parse(staleTombstone).empty, true);
    earlier.push(parent);
    parent = launch(`${kind}-restored`, cwd, [
      "--session",
      parentReady.sessionFile,
    ]);
    await parent.command("get_state");
    parentReady = await readReady(`${parent.output}.ready`);
    await assert.rejects(readFile(join(mailbox, `${parentId}.json`)), {
      code: "ENOENT",
    });
  }
  assert.equal(parentReady.sessionId, parentId);
  await parent.command("prompt", { message: "/handoff-proof arm" });
  const armed = await readArtifact(parent.output);
  assert.equal(armed.result.details.watches.length, 3);
  if (staleTombstone !== undefined)
    await writeFile(join(mailbox, `${parentId}.json`), staleTombstone);
  const parentFirst = kind === "distill";
  if (parentFirst) await parent.close();
  const snapshot = join(cwd, "snapshot.jsonl");
  await copyFile(parentReady.sessionFile, snapshot);
  await addDistillSummary({ kind, source: parentReady.sessionFile, snapshot });
  const declaration = { RATKING_SUCCEEDS: parentId };
  if (kind === "late") declaration.PI_UNTIL_HANDOFF_WAIT_MS = "300000";
  if (kind === "sigkill") declaration.PI_UNTIL_HANDOFF_WAIT_MS = "200";
  const rejected = [];
  if (kind === "binding") {
    // Actual bash-child env shape: private declaration was removed by its
    // parent; Rat King remains, and bash stamps the parent's session id.
    const inherited = launch(
      `${kind}-inherited`,
      cwd,
      ["--fork", snapshot, "--session-id", randomUUID()],
      { RATKING_SUCCEEDS: parentId, PI_SESSION_ID: parentId }
    );
    rejected.push(inherited);
    await inherited.command("get_state");
    const child = await readReady(`${inherited.output}.ready`);
    assert.equal(child.parentEnvId, parentId);
    const refused = await inherited.inspect();
    assert.equal(refused.result.details.watches.length, 0);
    assert.ok(!refused.result.content[0].text.includes("handoff: waiting"));
    await inherited.close();
  }
  const successors = (kind === "race" ? ["b", "c"] : ["b"]).map((suffix) => {
    const successorId = randomUUID();
    return launch(
      `${kind}-${suffix}`,
      cwd,
      ["--fork", snapshot, "--session-id", successorId],
      {
        ...declaration,
        ...(kind === "untargeted"
          ? {}
          : { PI_UNTIL_SUCCESSOR_ID: successorId }),
        ...(kind === "reload-claim" ? { HARNESS_INTERRUPT: "1" } : {}),
      }
    );
  });
  await Promise.all(successors.map((child) => child.command("get_state")));
  const ready = await Promise.all(
    successors.map((child) => readReady(`${child.output}.ready`))
  );
  for (const child of ready) {
    assert.equal(child.reason, "startup");
    assert.equal(child.parentSession, snapshot);
    assert.equal(child.declarationCleared, true);
    assert.equal(child.parentEnvId, undefined);
    assert.equal(child.scope, undefined);
    assert.equal(child.inheritedScope, undefined);
  }
  let rawProof;
  if (kind === "binding") {
    await successors[0].command("prompt", {
      message: "/handoff-proof spawn-raw",
    });
    const rawOutput = `${successors[0].output}.raw`;
    rawProof = await readRawProof(`${rawOutput}.proof`);
    const rawReady = await readReady(`${rawOutput}.ready`);
    assert.equal(rawReady.inheritedScope, undefined);
    assert.equal(rawReady.scope, undefined);
    assert.equal(rawReady.parentEnvId, undefined);
    assert.equal(rawProof.exitCode, 0);
    assert.equal(rawProof.agentStarts, 0);
    const rawState = await readArtifact(rawOutput);
    assert.equal(rawState.result.details.watches.length, 0);
    assert.ok(!rawState.result.content[0].text.includes("handoff: waiting"));
  }
  if (kind === "untargeted" || kind === "sigkill")
    return proveNoAdoption({
      kind,
      parent,
      parentReady,
      child: successors[0],
      ready: ready[0],
      armed,
    });
  if (kind === "chain")
    return proveChain({
      parent,
      parentReady,
      second: successors[0],
      secondReady: ready[0],
      cwd,
      armed,
    });
  const reloadReasons = [];
  let quitDelayMs = 0;
  if (!parentFirst) {
    const before = await Promise.all(
      successors.map((child) => child.inspect())
    );
    for (const result of before) {
      assert.equal(result.result.details.watches.length, 0);
      assert.ok(result.result.content[0].text.includes("handoff: waiting for"));
    }
    if (kind === "reload") {
      await successors[0].command("prompt", {
        message: "/handoff-proof reload",
      });
      const reloaded = await readReady(`${successors[0].output}.ready`);
      assert.equal(reloaded.reason, "reload");
      reloadReasons.push(reloaded.reason);
      const stillWaiting = await successors[0].inspect();
      assert.ok(
        stillWaiting.result.content[0].text.includes("handoff: waiting for")
      );
    }
    if (kind === "late") {
      // Deliberately test a >60-second quit. This is test stimulus, not polling.
      await delay(61_000);
      await successors[0].command("get_state");
      const stillWaiting = await successors[0].inspect();
      assert.ok(
        stillWaiting.result.content[0].text.includes("handoff: waiting for")
      );
      quitDelayMs = Date.now() - ready[0].startedAt;
      assert.ok(quitDelayMs > 60_000);
    }
    await parent.close();
  }
  if (kind === "reload-claim") {
    await waitForAdoption(successors, "handoff failed");
    const claims = await readdir(join(mailbox, "claimed"));
    assert.ok(claims.includes(`${parentId}!${ready[0].sessionId}.json`));
    await successors[0].command("prompt", { message: "/handoff-proof reload" });
    const reloaded = await readReady(`${successors[0].output}.ready`);
    assert.equal(reloaded.reason, "reload");
    reloadReasons.push(reloaded.reason);
  }
  const adopted = await waitForAdoption(successors);
  assert.ok(adopted, "one real forked successor adopts");
  // Closing waits for the extension's claim-commit task, giving us final real
  // session files and completed payload cleanup, not just an in-memory view.
  const after = await Promise.all(successors.map((child) => child.inspect()));
  const persistedParent = await readEntries(parentReady.sessionFile);
  const originalSuspension = newestSuspensionEntry(persistedParent);
  assert.ok(originalSuspension);
  assert.ok(originalSuspension.data.watches);
  const counts = await Promise.all(
    successors.map(async (child, index) => {
      const state = after[index];
      const restored = state.result.details.watches;
      const isWinner = child === adopted;
      assert.equal(restored.length, isWinner ? 3 : 0);
      if (isWinner) {
        assert.deepEqual(
          restored.map((watch) => watch.id).sort(),
          armed.result.details.watches.map((watch) => watch.id).sort()
        );
        for (const watch of restored) {
          const previous = armed.result.details.watches.find(
            (candidate) => candidate.id === watch.id
          );
          assert.ok(previous);
          assert.equal(watch.startedAt, previous.startedAt);
          assert.equal(watch.expiresAt, previous.expiresAt);
          assert.equal(watch.nextDueAt, previous.nextDueAt);
          assert.deepEqual(watch.contextRefs, previous.contextRefs);
          assert.equal(watch.quickRef, previous.quickRef);
          assert.equal(watch.reloads, 0);
        }
        const imported = newestSuspensionEntry(state.entries);
        assert.deepEqual(
          imported.data.watches,
          originalSuspension.data.watches
        );
        // The fixture computes phases from the transferred definitions/id, not
        // the successor session id. Compare against a real parent snapshot too.
        const parentPhases = originalSuspension.data.watches.map((watch) => ({
          id: watch.facts.id,
          phase:
            watch.definition.kind === "recurring"
              ? watch.facts.nextDueAt -
                watch.facts.startedAt -
                watch.definition.intervalMs
              : 0,
        }));
        for (const phase of state.phaseOffsets) {
          const original = parentPhases.find((item) => item.id === phase.id);
          if (
            restored.find((watch) => watch.id === phase.id)?.kind ===
            "recurring"
          )
            assert.equal(phase.phase, original.phase);
        }
      }
      await child.close();
      const entries = await readEntries(ready[index].sessionFile);
      const markers = entries.filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "pi-until-resumed"
      );
      assert.equal(markers.length, isWinner ? 1 : 0);
      if (isWinner) {
        assert.equal(markers[0].data.resumed, 3);
        assert.equal(markers[0].data.predecessorId, parentId);
        const claims = await readdir(join(mailbox, "claimed"));
        assert.ok(
          !claims.includes(`${parentId}!${ready[index].sessionId}.json`)
        );
      }
      return markers.length;
    })
  );
  const adoptionCount = counts.reduce((total, count) => total + count, 0);
  assert.equal(adoptionCount, 1);
  const all = [...earlier, parent, ...rejected, ...successors];
  assert.equal(
    all
      .flatMap((child) => child.records)
      .filter((record) => record.type === "agent_start").length,
    0
  );
  return {
    kind,
    parentId,
    successorReasons: ready.map((child) => child.reason),
    reloadReasons,
    inheritedChildrenRefused: rejected.length,
    rawChildrenRefused: rawProof === undefined ? 0 : 1,
    successorArgv: successors.map((child) => child.argv),
    sessionFiles: [
      parentReady.sessionFile,
      ...ready.map((child) => child.sessionFile),
    ],
    ids: armed.result.details.watches.map((watch) => watch.id),
    adoptionCount,
    expectedAdoptions: 1,
    watchAdoptions: 1,
    staleGuardProved: kind === "stale",
    coLoadedExtensions: kind === "distill",
    quitDelayMs,
    paidCalls: 0,
    exitCodes: [
      ...all.map((child) => child.child.exitCode),
      ...(rawProof === undefined ? [] : [rawProof.exitCode]),
    ],
  };
};

/** @param {string[]} kinds Ordered isolated proof cases.
 * @returns {Promise<Awaited<ReturnType<typeof runCase>>[]>} All case receipts.
 */
const runCases = async (kinds) => {
  const [kind, ...rest] = kinds;
  if (kind === undefined) return [];
  const proof = await runCase(kind);
  const later = await runCases(rest);
  return [proof, ...later];
};

try {
  const requested = process.argv[3];
  const cases = requested
    ? [requested]
    : [
        "distill",
        "restart",
        "race",
        "late",
        "binding",
        "reload",
        "reload-claim",
        "untargeted",
        "stale",
        "chain",
        "sigkill",
      ];
  assert.ok(
    cases.every((kind) =>
      [
        "distill",
        "restart",
        "race",
        "late",
        "binding",
        "reload",
        "reload-claim",
        "untargeted",
        "stale",
        "chain",
        "sigkill",
      ].includes(kind)
    )
  );
  const proofs = await runCases(cases);
  const proof = { root, home, launcher, proofs };
  await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally {
  for (const child of processes) if (child.exitCode === null) child.stdin.end();
}
