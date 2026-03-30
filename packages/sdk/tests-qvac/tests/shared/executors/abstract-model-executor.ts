import {
  BaseExecutor,
  type TestDefinitions,
} from "@tetherto/qvac-test-suite";
import type { ResourceManager } from "../resource-manager.js";
import { modelSetup, modelTeardown } from "../resource-lifecycle.js";

export abstract class AbstractModelExecutor<
  TDefs extends TestDefinitions,
> extends BaseExecutor<TDefs> {
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
