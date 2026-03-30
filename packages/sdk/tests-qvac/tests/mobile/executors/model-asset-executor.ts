import { AssetExecutor, type TestDefinitions } from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { modelSetup, modelTeardown } from "../../shared/resource-lifecycle.js";

/**
 * Combines AssetExecutor's resolveAsset() with the shared model
 * resource lifecycle (download, evict, load/unload).
 */
export abstract class ModelAssetExecutor<
  TDefs extends TestDefinitions,
> extends AssetExecutor<TDefs> {
  constructor(protected resources: ResourceManager) {
    super();
  }

  async setup(testId: string, context: unknown) {
    await modelSetup(this.resources, context);
  }

  async teardown(testId: string, context: unknown) {
    await modelTeardown(this.resources);
  }
}
