import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env };
try {
  const globalRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
  if (globalRoot.status !== 0 || globalRoot.stdout.trim() === "")
    throw new Error("npm root unavailable");
  const primary =
    env.PI_UNTIL_SIGNAL_EXIT_MODULE ??
    require.resolve("signal-exit", {
      paths: [join(globalRoot.stdout.trim(), "npm")],
    });
  const companion =
    env.PI_UNTIL_SIGNAL_EXIT_COMPANION_MODULE ??
    require.resolve("signal-exit", {
      paths: [
        join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
      ],
    });
  if (
    typeof require(primary).onExit !== "function" ||
    typeof require(companion) !== "function"
  )
    throw new Error("expected v4 and v3 module APIs");
  env.PI_UNTIL_SIGNAL_EXIT_MODULE = primary;
  env.PI_UNTIL_SIGNAL_EXIT_COMPANION_MODULE = companion;
  console.log(
    "[check:signals] Real signal-exit v4 and repo v3 enabled, including installed-both."
  );
} catch {
  delete env.PI_UNTIL_SIGNAL_EXIT_MODULE;
  delete env.PI_UNTIL_SIGNAL_EXIT_COMPANION_MODULE;
  console.warn(
    "[check:signals] WARNING: SKIPPING real signal-exit v4/v3 coverage; fake coverage still runs. Run npm install and ensure global npm bundles signal-exit v4, or set PI_UNTIL_SIGNAL_EXIT_MODULE and PI_UNTIL_SIGNAL_EXIT_COMPANION_MODULE to compatible modules."
  );
}
const result = spawnSync(
  process.execPath,
  [
    join(directory, "node_modules", "vitest", "vitest.mjs"),
    "run",
    ...process.argv.slice(2),
  ],
  { cwd: directory, env, stdio: "inherit" }
);
if (result.error !== undefined)
  console.error("[check:signals] Could not start Vitest.");
process.exitCode = result.status ?? 1;
