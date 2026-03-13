import { translate } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { bergamotTests } from "../../bergamot-tests.js";

export class BergamotExecutor extends AbstractModelExecutor<typeof bergamotTests> {
  pattern = /^bergamot-/;

  protected handlers = Object.fromEntries(
    bergamotTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string };
    const bergamotModelId = await this.resources.ensureLoaded("bergamot");

    try {
      const result = translate({
        modelId: bergamotModelId,
        text: p.text,
        modelType: "nmt",
        stream: false,
      });
      const translatedText = await (result as { text: Promise<string> }).text;

      return ValidationHelpers.validate(translatedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Bergamot error: ${errorMsg}` };
    }
  }
}
