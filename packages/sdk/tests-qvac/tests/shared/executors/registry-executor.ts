import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
} from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { registryTests } from "../../registry-tests.js";

type RegistryParams = {
  action: "list" | "search" | "getModel";
  filter?: string;
  engine?: string;
  quantization?: string;
  validateShape?: boolean;
  expectEmpty?: boolean;
  useFirstFromList?: boolean;
  matchList?: boolean;
  registryPath?: string;
  registrySource?: string;
};

type RegistryExpectation = Expectation;

export class RegistryExecutor extends AbstractModelExecutor<typeof registryTests> {
  pattern = /^registry-/;

  protected handlers = Object.fromEntries(
    registryTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as RegistryParams;
    const exp = expectation as RegistryExpectation;

    try {
      if (p.action === "list") return await this.handleList(p, exp);
      if (p.action === "search") return await this.handleSearch(p, exp);
      if (p.action === "getModel") return await this.handleGetModel(p, exp);
      return { passed: false, output: `Unknown action: ${p.action}` };
    } catch (error) {
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(
          error instanceof Error ? error.message : String(error),
          exp,
        );
      }
      return { passed: false, output: `Registry error: ${error}` };
    }
  }

  private async handleList(p: RegistryParams, exp: RegistryExpectation): Promise<TestResult> {
    const models = await modelRegistryList();

    if (p.validateShape && models.length > 0) {
      const entry = models[0]!;
      const required = ["name", "registryPath", "registrySource", "modelId", "addon", "engine"];
      const missing = required.filter((f) => (entry as Record<string, unknown>)[f] === undefined);
      if (missing.length > 0) return { passed: false, output: `Missing fields: ${missing.join(", ")}` };
    }

    return ValidationHelpers.validate(models, exp);
  }

  private async handleSearch(p: RegistryParams, exp: RegistryExpectation): Promise<TestResult> {
    const searchParams: Record<string, string> = {};
    if (p.filter) searchParams.filter = p.filter;
    if (p.engine) searchParams.engine = p.engine;
    if (p.quantization) searchParams.quantization = p.quantization;

    const models = await modelRegistrySearch(searchParams);

    if (p.expectEmpty && models.length !== 0) {
      return { passed: false, output: `Expected 0 results, got ${models.length}` };
    }

    return ValidationHelpers.validate(models, exp);
  }

  private async handleGetModel(p: RegistryParams, exp: RegistryExpectation): Promise<TestResult> {
    let registryPath = p.registryPath;
    let registrySource = p.registrySource;
    let listEntry: Record<string, unknown> | undefined;

    if (p.useFirstFromList) {
      const models = await modelRegistryList();
      if (models.length === 0) return { passed: false, output: "No models in registry" };
      const first = models[0]!;
      registryPath = first.registryPath;
      registrySource = first.registrySource;
      listEntry = first as Record<string, unknown>;
    }

    const model = await modelRegistryGetModel(registryPath!, registrySource!);

    if (p.matchList && listEntry) {
      const fields = ["name", "registryPath", "registrySource", "addon", "engine", "modelId"];
      const mismatches = fields.filter((f) => String(listEntry![f]) !== String((model as Record<string, unknown>)[f]));
      if (mismatches.length > 0) return { passed: false, output: `Mismatches: ${mismatches.join(", ")}` };
    }

    return ValidationHelpers.validate(model.name, exp);
  }
}
