import {
  BaseExecutor,
  type TestDefinitions,
} from "@tetherto/qvac-test-suite";
import type { ResourceManager } from "../resource-manager.js";

export abstract class AbstractModelExecutor<
  TDefs extends TestDefinitions,
> extends BaseExecutor<TDefs> {
  constructor(protected resources: ResourceManager) {
    super();
  }

  async setup(testId: string, context: unknown) {
    const ctx = (context ?? {}) as Record<string, unknown>;

    await this.resources.downloadAllOnce(console.log);
    this.resources.incrementTestCount();

    const dep = ctx.dependency as string | undefined;
    if (!dep || dep === "none") return;

    const deps = dep.includes("+") ? dep.split("+") : [dep];
    await this.resources.evictExcept(deps);

    for (const d of deps) {
      await this.resources.ensureLoaded(d);
    }
  }

  async teardown(testId: string, context: unknown) {
    await this.resources.evictStale(5);
  }
}
