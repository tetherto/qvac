import { transcribe } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  wrongModelTests,
  wrongModelTranscribeOnLlm,
} from "../../wrong-model-tests.js";

export class WrongModelExecutor extends AbstractModelExecutor<
  typeof wrongModelTests
> {
  pattern = /^wrong-model-/;

  protected handlers = {
    [wrongModelTranscribeOnLlm.testId]: this.transcribeOnLlm.bind(this),
  };

  async transcribeOnLlm(
    _params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded("llm");

    try {
      await transcribe({
        modelId: llmModelId,
        audioChunk: "/tmp/anything-not-touched-because-we-throw-first.wav",
      });
      return {
        passed: false,
        output: `Expected transcribe() against an LLM model to throw, but it returned successfully.`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      const checks = {
        mentionsRequestedOperation: errorMsg.includes("transcribe"),
        mentionsLoadedType: errorMsg.includes("llamacpp-completion"),
        suggestsTranscriptionModel:
          errorMsg.includes("whispercpp-transcription") ||
          errorMsg.includes("parakeet-transcription"),
      };
      const allOk = Object.values(checks).every(Boolean);

      if (!allOk) {
        return {
          passed: false,
          output: `Wrong-model error fired but content checks failed. checks=${JSON.stringify(checks)} message="${errorMsg}"`,
        };
      }

      return ValidationHelpers.validate(errorMsg, expectation as Expectation);
    }
  }
}
