import test from "brittle";
import type { SuspendableSwarm, SuspendableStore } from "@/server/bare/runtime-lifecycle";
import {
  registerSwarm,
  unregisterSwarm,
  registerCorestore,
  unregisterCorestore,
  suspendRuntime,
  resumeRuntime,
  getLifecycleState,
  getRegisteredResourceCounts,
  resetLifecycleState,
} from "@/server/bare/runtime-lifecycle";

interface MockOptions {
  failSuspend?: boolean;
  failResume?: boolean;
  delayMs?: number;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createMockSwarm(label: string, log: string[], opts?: MockOptions): SuspendableSwarm {
  const mock = {
    suspended: false,
    async suspend() {
      if (opts?.delayMs) await delay(opts.delayMs);
      if (opts?.failSuspend) throw new Error(`${label} suspend failed`);
      log.push(`${label}:suspend`);
      mock.suspended = true;
    },
    async resume() {
      if (opts?.delayMs) await delay(opts.delayMs);
      if (opts?.failResume) throw new Error(`${label} resume failed`);
      log.push(`${label}:resume`);
      mock.suspended = false;
    },
  };
  return mock;
}

function createMockStore(label: string, log: string[], opts?: MockOptions): SuspendableStore {
  return {
    async suspend() {
      if (opts?.delayMs) await delay(opts.delayMs);
      if (opts?.failSuspend) throw new Error(`${label} suspend failed`);
      log.push(`${label}:suspend`);
    },
    async resume() {
      if (opts?.delayMs) await delay(opts.delayMs);
      if (opts?.failResume) throw new Error(`${label} resume failed`);
      log.push(`${label}:resume`);
    },
  };
}

function setup(log: string[], swarmOpts?: MockOptions, storeOpts?: MockOptions) {
  resetLifecycleState();
  const swarm = createMockSwarm("swarm", log, swarmOpts);
  const store = createMockStore("store", log, storeOpts);
  registerSwarm(swarm, { label: "test-swarm", createdAt: Date.now() });
  registerCorestore(store, { label: "test-store", createdAt: Date.now() });
  return { swarm, store };
}

test("suspend order: swarms before stores", async (t: { alike: Function }) => {
  const log: string[] = [];
  setup(log);

  await suspendRuntime();

  t.alike(log, ["swarm:suspend", "store:suspend"]);
});

test("resume order: stores before swarms", async (t: { alike: Function }) => {
  const log: string[] = [];
  setup(log);

  await suspendRuntime();
  log.length = 0;
  await resumeRuntime();

  t.alike(log, ["store:resume", "swarm:resume"]);
});

test("suspend is idempotent when already suspended", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log);

  await suspendRuntime();
  t.is(getLifecycleState(), "suspended");

  log.length = 0;
  await suspendRuntime();

  t.alike(log, []);
  t.is(getLifecycleState(), "suspended");
});

test("resume is idempotent when already active", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log);

  t.is(getLifecycleState(), "active");

  await resumeRuntime();

  t.alike(log, []);
  t.is(getLifecycleState(), "active");
});

test("concurrent suspend calls share the same transition", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log, { delayMs: 20 });

  const [r1, r2] = await Promise.all([suspendRuntime(), suspendRuntime()]);

  t.is(r1, undefined);
  t.is(r2, undefined);
  t.alike(log, ["swarm:suspend", "store:suspend"]);
  t.is(getLifecycleState(), "suspended");
});

test("concurrent resume calls share the same transition", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log, { delayMs: 20 });

  await suspendRuntime();
  log.length = 0;

  await Promise.all([resumeRuntime(), resumeRuntime()]);

  t.alike(log, ["store:resume", "swarm:resume"]);
  t.is(getLifecycleState(), "active");
});

test("resume during in-flight suspend waits then resumes", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log, { delayMs: 30 });

  const suspendP = suspendRuntime();
  await delay(5);
  const resumeP = resumeRuntime();

  await suspendP;
  await resumeP;

  t.alike(log, ["swarm:suspend", "store:suspend", "store:resume", "swarm:resume"]);
  t.is(getLifecycleState(), "active");
});

test("suspend during in-flight resume waits then suspends", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  setup(log, { delayMs: 30 });

  await suspendRuntime();
  log.length = 0;

  const resumeP = resumeRuntime();
  await delay(5);
  const suspendP = suspendRuntime();

  await resumeP;
  await suspendP;

  t.alike(log, ["store:resume", "swarm:resume", "swarm:suspend", "store:suspend"]);
  t.is(getLifecycleState(), "suspended");
});

test("partial suspend failure commits to suspended state", async (t: { is: Function; ok: Function }) => {
  const log: string[] = [];
  resetLifecycleState();

  const swarm = createMockSwarm("swarm", log);
  const store = createMockStore("store", log, { failSuspend: true });
  registerSwarm(swarm, { label: "test-swarm", createdAt: Date.now() });
  registerCorestore(store, { label: "test-store", createdAt: Date.now() });

  let caught = false;
  try {
    await suspendRuntime();
  } catch {
    caught = true;
  }

  t.ok(caught);
  t.is(getLifecycleState(), "suspended");
});

test("suspend after partial failure is a no-op", async (t: { is: Function; alike: Function }) => {
  const log: string[] = [];
  resetLifecycleState();

  const swarm = createMockSwarm("swarm", log);
  const store = createMockStore("store", log, { failSuspend: true });
  registerSwarm(swarm, { label: "test-swarm", createdAt: Date.now() });
  registerCorestore(store, { label: "test-store", createdAt: Date.now() });

  try { await suspendRuntime(); } catch { /* expected */ }

  log.length = 0;
  await suspendRuntime();

  t.alike(log, []);
  t.is(getLifecycleState(), "suspended");
});

test("resume after partial suspend failure repairs state", async (t: { is: Function; ok: Function }) => {
  const log: string[] = [];
  resetLifecycleState();

  const swarm = createMockSwarm("swarm", log);
  const store = createMockStore("store", log, { failSuspend: true });
  registerSwarm(swarm, { label: "test-swarm", createdAt: Date.now() });
  registerCorestore(store, { label: "test-store", createdAt: Date.now() });

  try { await suspendRuntime(); } catch { /* expected */ }

  log.length = 0;
  await resumeRuntime();

  t.is(getLifecycleState(), "active");
  t.ok(log.includes("store:resume"));
  t.ok(log.includes("swarm:resume"));
});

test("resource unregistered during transition does not fail", async (t: { is: Function }) => {
  const log: string[] = [];
  resetLifecycleState();

  const swarm = createMockSwarm("swarm", log, { delayMs: 30 });
  const store = createMockStore("store", log);
  registerSwarm(swarm, { label: "test-swarm", createdAt: Date.now() });
  registerCorestore(store, { label: "test-store", createdAt: Date.now() });

  const suspendP = suspendRuntime();
  unregisterCorestore(store);
  await suspendP;

  t.is(getLifecycleState(), "suspended");
});

test("register and unregister updates resource counts", (t: { is: Function }) => {
  resetLifecycleState();

  const log: string[] = [];
  const swarm = createMockSwarm("swarm", log);
  const store = createMockStore("store", log);

  t.is(getRegisteredResourceCounts().swarms, 0);
  t.is(getRegisteredResourceCounts().stores, 0);

  registerSwarm(swarm, { label: "s", createdAt: Date.now() });
  registerCorestore(store, { label: "c", createdAt: Date.now() });

  t.is(getRegisteredResourceCounts().swarms, 1);
  t.is(getRegisteredResourceCounts().stores, 1);

  unregisterSwarm(swarm);
  unregisterCorestore(store);

  t.is(getRegisteredResourceCounts().swarms, 0);
  t.is(getRegisteredResourceCounts().stores, 0);
});
