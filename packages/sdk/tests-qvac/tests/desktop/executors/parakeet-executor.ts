import { transcribe } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { parakeetTests } from "../../parakeet-tests.js";

export class ParakeetExecutor extends AbstractModelExecutor<
  typeof parakeetTests
> {
  pattern = /^parakeet-/;

  protected handlers = Object.fromEntries(
    parakeetTests.map((test) => [
      test.testId,
      (params: unknown, expectation: unknown) =>
        this.runTest(test.testId, params, expectation),
    ]),
  ) as never;

  async runTest(testId: string, params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string };
    const exp = expectation as Expectation;

    const resourceKey = this.resolveResource(testId);
    const modelId = await this.resources.ensureLoaded(resourceKey);

    const audioPath = path.resolve(
      process.cwd(),
      "assets/audio",
      p.audioFileName,
    );

    try {
      const text = await transcribe({
        modelId,
        audioChunk: audioPath,
      });
      const trimmedText = text.trim();

      if (exp.validation === "throws-error") {
        return { passed: false, output: "Expected error but transcription succeeded" };
      }
      return ValidationHelpers.validate(trimmedText, exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (exp.validation === "throws-error") {
        return ValidationHelpers.validate(errorMsg, exp);
      }
      return { passed: false, output: `Parakeet transcription failed: ${errorMsg}` };
    }
  }

  private resolveResource(testId: string): string {
    if (testId.startsWith("parakeet-ctc-")) return "parakeet-ctc";
    if (testId.startsWith("parakeet-sortformer-")) return "parakeet-sortformer";
    return "parakeet-tdt";
  }
}
