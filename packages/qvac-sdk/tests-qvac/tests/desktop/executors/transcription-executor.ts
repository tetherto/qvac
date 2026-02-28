import { transcribe } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { transcriptionTests } from "../../transcription-tests.js";

export class TranscriptionExecutor extends AbstractModelExecutor<
  typeof transcriptionTests
> {
  pattern = /^transcription-/;

  protected handlers = Object.fromEntries(
    transcriptionTests.map((test) => [test.testId, this.generic.bind(this)]),
  ) as never;

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number };
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    const audioPath = path.resolve(
      process.cwd(),
      "../shared-test-data/audio",
      p.audioFileName,
    );

    try {
      const text = await transcribe({
        modelId: whisperModelId,
        audioChunk: audioPath,
      });
      const trimmedText = text.trim();

      return ValidationHelpers.validate(
        trimmedText,
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Transcription failed: ${errorMsg}` };
    }
  }
}
