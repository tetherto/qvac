import type { ResourceManager } from "./resource-manager.js";

export async function modelSetup(resources: ResourceManager, context: unknown) {
  const ctx = (context ?? {}) as Record<string, unknown>;

  await resources.downloadAllOnce(console.log);
  resources.incrementTestCount();

  const dep = ctx.dependency as string | undefined;
  // dependency:"none" means the test declares it needs no preloaded model.
  // Treat this as "evict everything currently held" — otherwise residue
  // from the previous test (e.g. a 2GB translation model) stays resident
  // while the next test allocates fresh memory on top of it, blowing the
  // device memory budget on mobile (afriquegemma → sharded-model-load was
  // the empirical case this manifested as).
  const deps =
    !dep || dep === "none"
      ? []
      : dep.includes("+")
        ? dep.split("+")
        : [dep];

  await resources.evictExcept(deps);

  for (const d of deps) {
    await resources.ensureLoaded(d);
  }
}

export async function modelTeardown(resources: ResourceManager) {
  await resources.evictStale(5);
}
