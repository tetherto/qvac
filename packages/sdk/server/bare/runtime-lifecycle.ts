import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export interface SuspendableSwarm {
  readonly suspended: boolean;
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

export interface SuspendableStore {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

type LifecycleState = "active" | "suspending" | "suspended" | "resuming";

interface ResourceMeta {
  label: string;
  createdAt: number;
}

const swarms = new Map<SuspendableSwarm, ResourceMeta>();
const stores = new Map<SuspendableStore, ResourceMeta>();

let state: LifecycleState = "active";
let transitionPromise: Promise<void> | null = null;

export function registerSwarm(swarm: SuspendableSwarm, meta: ResourceMeta) {
  swarms.set(swarm, meta);
  logger.debug(`Lifecycle: registered swarm [${meta.label}]`);
}

export function unregisterSwarm(swarm: SuspendableSwarm) {
  const meta = swarms.get(swarm);
  swarms.delete(swarm);
  if (meta) {
    logger.debug(`Lifecycle: unregistered swarm [${meta.label}]`);
  }
}

export function registerCorestore(store: SuspendableStore, meta: ResourceMeta) {
  stores.set(store, meta);
  logger.debug(`Lifecycle: registered corestore [${meta.label}]`);
}

export function unregisterCorestore(store: SuspendableStore) {
  const meta = stores.get(store);
  stores.delete(store);
  if (meta) {
    logger.debug(`Lifecycle: unregistered corestore [${meta.label}]`);
  }
}

export function getLifecycleState(): LifecycleState {
  return state;
}

export function getRegisteredResourceCounts() {
  return { swarms: swarms.size, stores: stores.size };
}

export function resetLifecycleState() {
  swarms.clear();
  stores.clear();
  state = "active";
  transitionPromise = null;
}

async function runPhase<T>(
  snapshot: Array<[T, ResourceMeta]>,
  liveSet: Map<T, ResourceMeta>,
  fn: (resource: T) => Promise<void>,
  phaseLabel: string,
) {
  const errors: unknown[] = [];

  for (const [resource, meta] of snapshot) {
    try {
      await fn(resource);
      logger.debug(`Lifecycle: ${phaseLabel} [${meta.label}] OK`);
    } catch (error) {
      if (!liveSet.has(resource)) continue;
      logger.error(`Lifecycle: ${phaseLabel} [${meta.label}] failed:`, error);
      errors.push(new Error(`${meta.label}: ${String(error)}`));
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Lifecycle ${phaseLabel} phase failed`);
  }
}

export async function suspendRuntime(): Promise<void> {
  if (state === "suspended") return;

  if (state === "suspending" && transitionPromise) return transitionPromise;

  // Opposite transition in flight: wait for it, then re-evaluate
  if (state === "resuming" && transitionPromise) {
    await transitionPromise;
    return suspendRuntime();
  }

  state = "suspending";

  logger.info(
    `⏸️ Suspending runtime (${swarms.size} swarms, ${stores.size} stores)`,
  );

  transitionPromise = (async () => {
    const swarmSnapshot = Array.from(swarms.entries());
    const storeSnapshot = Array.from(stores.entries());

    await runPhase(
      swarmSnapshot,
      swarms,
      async (swarm) => {
        if (!swarm.suspended) await swarm.suspend();
      },
      "suspend-swarm",
    );

    await runPhase(
      storeSnapshot,
      stores,
      async (store) => {
        await store.suspend();
      },
      "suspend-store",
    );
  })()
    .then(() => {
      state = "suspended";
      logger.info("⏸️ Runtime suspended");
    })
    .catch((error: unknown) => {
      // Partial failure: commit to target so recovery resume() can repair
      // instead of leaving state as "suspending" which blocks all future calls.
      state = "suspended";
      logger.error("⏸️ Runtime suspend partially failed, state committed for recovery");
      throw error;
    })
    .finally(() => {
      transitionPromise = null;
    });

  return transitionPromise;
}

export async function resumeRuntime(): Promise<void> {
  if (state === "active") return;

  if (state === "resuming" && transitionPromise) return transitionPromise;

  if (state === "suspending" && transitionPromise) {
    await transitionPromise;
    return resumeRuntime();
  }

  state = "resuming";

  logger.info(
    `▶️ Resuming runtime (${stores.size} stores, ${swarms.size} swarms)`,
  );

  transitionPromise = (async () => {
    const storeSnapshot = Array.from(stores.entries());
    const swarmSnapshot = Array.from(swarms.entries());

    await runPhase(
      storeSnapshot,
      stores,
      async (store) => {
        await store.resume();
      },
      "resume-store",
    );

    await runPhase(
      swarmSnapshot,
      swarms,
      async (swarm) => {
        await swarm.resume();
      },
      "resume-swarm",
    );
  })()
    .then(() => {
      state = "active";
      logger.info("▶️ Runtime resumed");
    })
    .catch((error: unknown) => {
      state = "active";
      logger.error("▶️ Runtime resume partially failed, state committed for recovery");
      throw error;
    })
    .finally(() => {
      transitionPromise = null;
    });

  return transitionPromise;
}
