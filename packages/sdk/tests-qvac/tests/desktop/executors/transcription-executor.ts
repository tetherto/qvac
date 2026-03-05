// Transcription executor
import { transcribe } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { transcriptionTests } from "../../transcription-tests.js";
import { ModelManager } from "../model-manager.js";

export class TranscriptionExecutor {
  pattern = /^transcription-/;

  // All transcription tests use generic handler
  handlers = Object.fromEntries(
    transcriptionTests.map((test) => [test.testId, this.generic]),
  );

  async execute(
    testId: string,
    context: unknown,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const handler = this.handlers[testId];
    if (handler) {
      return await (
        handler as (
          params: unknown,
          expectation: unknown,
        ) => Promise<TestResult>
      ).call(this, params, expectation);
    }
    return { passed: false, output: `Unknown test: ${testId}` };
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number };
    const whisperModelId = await ModelManager.getWhisperModel();

    // Get audio file path (resolve from current working directory up to repo root)
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
      // Some tests expect errors (corrupted files)
      return { passed: false, output: `Transcription failed: ${errorMsg}` };
    }
  }
}
