import { transcribe } from "@qvac/sdk";
import {
  AssetExecutor,
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { transcriptionTests } from "../../transcription-tests.js";

export class MobileTranscriptionExecutor extends AssetExecutor<
  typeof transcriptionTests
> {
  pattern = /^transcription-/;
  protected handlers = {};
  protected defaultHandler = this.transcribeAudio.bind(this);

  private audioAssets: Record<string, number> | null = null;

  constructor(private resources: ResourceManager) {
    super();
  }

  async setup(testId: string, context: unknown) {
    const ctx = (context ?? {}) as Record<string, unknown>;
    await this.resources.downloadAllOnce(console.log);
    const dep = ctx.dependency as string | undefined;
    if (dep && dep !== "none") {
      await this.resources.ensureLoaded(dep);
    }
  }

  async teardown(testId: string, context: unknown) {
    await this.resources.evictStale(5);
  }

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.audioAssets = assets.audio;
    }
    return this.audioAssets!;
  }

  private async transcribeAudio(
    testId: string,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number };
    const exp = expectation as Expectation;

    const whisperModelId = await this.resources.ensureLoaded("whisper");

    const audio = await this.loadAudioAssets();
    const assetModule = audio[p.audioFileName];
    if (!assetModule) {
      return {
        passed: false,
        output: `Audio file not found: ${p.audioFileName}`,
      };
    }

    try {
      const audioUri = await this.resolveAsset(assetModule);
      const text = await transcribe({
        modelId: whisperModelId,
        audioChunk: audioUri,
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
      return { passed: false, output: `Transcription failed: ${errorMsg}` };
    }
  }
}
