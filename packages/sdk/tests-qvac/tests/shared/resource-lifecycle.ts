import type { ResourceManager } from "./resource-manager.js";

export async function modelSetup(resources: ResourceManager, context: unknown) {
  const ctx = (context ?? {}) as Record<string, unknown>;

  await resources.downloadAllOnce(console.log);
  resources.incrementTestCount();

  const dep = ctx.dependency as string | undefined;
  if (!dep || dep === "none") return;

  const deps = dep.includes("+") ? dep.split("+") : [dep];
  await resources.evictExcept(deps);

  for (const d of deps) {
    await resources.ensureLoaded(d);
  }
}

export async function modelTeardown(resources: ResourceManager) {
  await resources.evictStale(5);
}
