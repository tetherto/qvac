import { loadModel, transcribe } from "@qvac/sdk";
import {
  AssetExecutor,
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { configReloadTests } from "../../config-reload-tests.js";

export class MobileConfigReloadExecutor extends AssetExecutor<typeof configReloadTests> {
  pattern = /^config-reload-/;

  protected handlers = {
    "config-reload-whisper-language": this.reloadConfig.bind(this),
    "config-reload-whisper-params": this.reloadConfig.bind(this),
    "config-reload-preserves-id": this.preservesId.bind(this),
    "config-reload-invalid-model-id": this.invalidModelId.bind(this),
    "config-reload-wrong-model-type": this.wrongModelType.bind(this),
    "config-reload-then-transcribe": this.thenTranscribe.bind(this),
  } as never;
  protected defaultHandler = undefined;

  private audioAssets: Record<string, number> | null = null;

  constructor(private resources: ResourceManager) {
    super();
  }

  async setup(testId: string, context: unknown) {
    const ctx = (context ?? {}) as Record<string, unknown>;
    await this.resources.downloadAllOnce(console.log);
    const dep = ctx.dependency as string | undefined;
    if (dep && dep !== "none") {
      await this.resources.evictAll();
      await this.resources.ensureLoaded(dep);
    }
  }

  async teardown() {
    await this.resources.evictAll();
  }

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.audioAssets = assets.audio;
    }
    return this.audioAssets!;
  }

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

      const audio = await this.loadAudioAssets();
      const assetModule = audio[p.audioFileName];
      if (!assetModule) {
        return { passed: false, output: `Audio file not found: ${p.audioFileName}` };
      }
      const audioUri = await this.resolveAsset(assetModule);
      const text = (await transcribe({ modelId: whisperModelId, audioChunk: audioUri })).trim();

      return ValidationHelpers.validate(text, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Config reload + transcribe error: ${errorMsg}` };
    }
  }
}
