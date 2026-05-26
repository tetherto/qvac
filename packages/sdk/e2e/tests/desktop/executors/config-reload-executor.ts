import { loadModel, transcribe } from "@qvac/sdk";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { configReloadTests } from "../../config-reload-tests.js";

export class ConfigReloadExecutor extends AbstractModelExecutor<typeof configReloadTests> {
  pattern = /^config-reload-/;

  protected handlers = {
    "config-reload-whisper-language": this.reloadConfig.bind(this),
    "config-reload-whisper-params": this.reloadConfig.bind(this),
    "config-reload-preserves-id": this.preservesId.bind(this),
    "config-reload-invalid-model-id": this.invalidModelId.bind(this),
    "config-reload-wrong-model-type": this.wrongModelType.bind(this),
    "config-reload-then-transcribe": this.thenTranscribe.bind(this),
  } as never;

  async reloadConfig(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { newLanguage?: string; newConfig?: Record<string, unknown> };
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    try {
      const newConfig = p.newConfig ?? { language: p.newLanguage ?? "es" };
      const reloadedId = await loadModel({
        modelId: whisperModelId,
        modelType: "whisper",
        modelConfig: newConfig,
      } as never);

      const sameId = reloadedId === whisperModelId;
      return ValidationHelpers.validate(
        `Config reload success, sameId=${sameId}`,
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Config reload error: ${errorMsg}` };
    }
  }

  async preservesId(params: unknown, expectation: unknown): Promise<TestResult> {
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    try {
      const reloadedId = await loadModel({
        modelId: whisperModelId,
        modelType: "whisper",
        modelConfig: { language: "fr" },
      } as never);

      const preserved = reloadedId === whisperModelId;
      return ValidationHelpers.validate(
        `Model ID ${preserved ? "preserved" : "NOT preserved"}: original=${whisperModelId}, reloaded=${reloadedId}`,
        expectation as Expectation,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Config reload error: ${errorMsg}` };
    }
  }

  async invalidModelId(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { invalidModelId: string };

    try {
      await loadModel({
        modelId: p.invalidModelId,
        modelType: "whisper",
        modelConfig: { language: "en" },
      } as never);
      return { passed: false, output: "Expected error for invalid model ID" };
    } catch (error) {
      return { passed: true, output: `Correctly rejected: ${error}` };
    }
  }

  async wrongModelType(params: unknown, expectation: unknown): Promise<TestResult> {
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    try {
      await loadModel({
        modelId: whisperModelId,
        modelType: "llm",
        modelConfig: { n_ctx: 2048 },
      } as never);
      return { passed: false, output: "Expected error for model type mismatch" };
    } catch (error) {
      return { passed: true, output: `Correctly rejected: ${error}` };
    }
  }

  async thenTranscribe(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string; newLanguage: string };
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    try {
      await loadModel({
        modelId: whisperModelId,
        modelType: "whisper",
        modelConfig: { language: p.newLanguage },
      } as never);

      const audioPath = path.resolve(process.cwd(), "assets/audio", p.audioFileName);
      const text = (await transcribe({ modelId: whisperModelId, audioChunk: audioPath })).trim();

      return ValidationHelpers.validate(text, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Config reload + transcribe error: ${errorMsg}` };
    }
  }
}
