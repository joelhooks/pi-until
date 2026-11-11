export interface ExitPersistence {
  /** Journal and stop checks, without publishing ahead of host settlement. */
  readonly signal: () => void;
  /** Reconcile synchronously and publish immediately before process exit. */
  readonly exit: () => void;
  /** One delayed observation when a host catches a signal and stays alive. */
  readonly stillAlive?: (signal: "SIGHUP" | "SIGTERM", delayMs: number) => void;
}

interface ExitRegistry {
  readonly clients: Set<ExitPersistence>;
  readonly detach: () => void;
}

// This key and registry shape are a compatibility protocol, not a package
// version. Future versions must reuse it; parallel registries swallow signals.
// Add optional protocol fields instead of creating a v2 key.
const registryKey = Symbol.for("pi-until.exit-persistence.v1");
const processGlobal = globalThis as typeof globalThis & {
  [registryKey]?: ExitRegistry;
};

const signalExitListenerCount = (): number => {
  const emitters = new Set<unknown>([
    Reflect.get(process, "__signal_exit_emitter__"),
    Reflect.get(process, Symbol.for("signal-exit emitter")),
  ]);
  let count = 0;
  for (const emitter of emitters) {
    if (typeof emitter !== "object" || emitter === null) continue;
    const value: unknown = Reflect.get(emitter, "count");
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      count += value;
  }
  return count;
};

export const CAUGHT_SIGNAL_WARNING_MS = 5_000;

const createRegistry = (): ExitRegistry => {
  const clients = new Set<ExitPersistence>();
  const warned = new WeakSet<ExitPersistence>();
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let detached = false;
  const onExit = (code: number) => {
    // Interactive Pi uses 129 for a dead terminal and 0 for graceful signals.
    // RPC/print hosts can explicitly exit 143 for TERM. Default signal delivery
    // does not emit 'exit'. Unrelated crash exit codes create no quit authority.
    if (code === 0 || code === 129 || code === 143)
      for (const client of clients) client.exit();
  };
  const onSignal = (signal: "SIGHUP" | "SIGTERM") => {
    if (detached) return;
    for (const client of clients) client.signal();
    const ownListener = signal === "SIGHUP" ? onHangup : onTerminate;
    const foreign = process
      .listeners(signal)
      .filter((listener) => listener !== ownListener).length;
    // signal-exit (v3/v4) observes default termination; it is not a host that
    // settles our sessions. It also waits for us to detach before re-raising.
    if (foreign > signalExitListenerCount()) {
      if (warningTimer === undefined) {
        warningTimer = setTimeout(() => {
          warningTimer = undefined;
          for (const client of clients) {
            if (warned.has(client)) continue;
            warned.add(client);
            client.stillAlive?.(signal, CAUGHT_SIGNAL_WARNING_MS);
          }
        }, CAUGHT_SIGNAL_WARNING_MS);
        warningTimer.unref();
      }
      return;
    }
    // No host will settle or exit for us. Publish all instances before restoring
    // the signal's default action, not one re-raise per package copy.
    for (const client of clients) client.exit();
    registry.detach();
    process.kill(process.pid, signal);
  };
  const onHangup = () => onSignal("SIGHUP");
  const onTerminate = () => onSignal("SIGTERM");
  const registry: ExitRegistry = {
    clients,
    detach: () => {
      detached = true;
      clearTimeout(warningTimer);
      process.off("exit", onExit);
      process.off("SIGHUP", onHangup);
      process.off("SIGTERM", onTerminate);
      if (processGlobal[registryKey] === registry)
        Reflect.deleteProperty(processGlobal, registryKey);
    },
  };
  process.on("exit", onExit);
  // Observe ordinary host handlers before once-handlers remove themselves or
  // dispose removes them during this same signal dispatch.
  process.prependListener("SIGHUP", onHangup);
  process.prependListener("SIGTERM", onTerminate);
  return registry;
};

export const registerExitPersistence = (
  client: ExitPersistence
): (() => void) => {
  const registry = processGlobal[registryKey] ?? createRegistry();
  processGlobal[registryKey] = registry;
  registry.clients.add(client);
  return () => {
    registry.clients.delete(client);
    if (registry.clients.size === 0) registry.detach();
  };
};
