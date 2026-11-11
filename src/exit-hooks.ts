export interface ExitPersistence {
  /** Journal and stop checks, without publishing ahead of host settlement. */
  readonly signal: () => void;
  /** Reconcile synchronously and publish immediately before process exit. */
  readonly exit: () => void;
}

interface ExitRegistry {
  readonly clients: Set<ExitPersistence>;
  readonly detach: () => void;
}

// Duplicate package loads and SDK sessions must share one process signal hook.
const registryKey = Symbol.for("pi-until.exit-persistence.v1");
const processGlobal = globalThis as typeof globalThis & {
  [registryKey]?: ExitRegistry;
};

const createRegistry = (): ExitRegistry => {
  const clients = new Set<ExitPersistence>();
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
    if (process.listeners(signal).some((listener) => listener !== ownListener))
      return;
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
      process.off("exit", onExit);
      process.off("SIGHUP", onHangup);
      process.off("SIGTERM", onTerminate);
      if (processGlobal[registryKey] === registry)
        Reflect.deleteProperty(processGlobal, registryKey);
    },
  };
  process.on("exit", onExit);
  process.on("SIGHUP", onHangup);
  process.on("SIGTERM", onTerminate);
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
