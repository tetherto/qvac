import { transcribe } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { transcriptionTests } from "../../transcription-tests.js";

export class MobileTranscriptionExecutor extends ModelAssetExecutor<
  typeof transcriptionTests
> {
  pattern = /^transcription-/;
  protected handlers = {};
  protected defaultHandler = this.transcribeAudio.bind(this);

  private audioAssets: Record<string, number> | null = null;

  constructor(resources: ResourceManager) {
    super(resources);
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
