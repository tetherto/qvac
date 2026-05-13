import { transcribe } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { transcriptionTests } from "../../transcription-tests.js";
import {
  runMetadataStreamDuplex,
  validateSegments,
  type MetadataStreamOptions,
} from "../../shared/transcription-segments.js";

export class MobileTranscriptionExecutor extends ModelAssetExecutor<
  typeof transcriptionTests
> {
  pattern = /^transcription-/;
  protected handlers = {
    "transcription-metadata-batch": this.metadataBatch.bind(this),
    "transcription-metadata-streaming": this.metadataStreaming.bind(this),
  };
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

  private async resolveAudioAssetUri(audioFileName: string): Promise<string | TestResult> {
    const audio = await this.loadAudioAssets();
    const assetModule = audio[audioFileName];
    if (!assetModule) {
      return { passed: false, output: `Audio file not found: ${audioFileName}` };
    }
    return this.resolveAsset(assetModule);
  }

  private async loadAudioBytes(audioFileName: string): Promise<Uint8Array | TestResult> {
    const uriResult = await this.resolveAudioAssetUri(audioFileName);
    if (typeof uriResult !== "string") return uriResult;
    // @ts-ignore - expo-file-system is a peer dependency available in mobile context
    const { File } = await import("expo-file-system");
    return await new File(`file://${uriResult}`).bytes();
  }

  private async transcribeAudio(
    testId: string,
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number };
    const exp = expectation as Expectation;

    const whisperModelId = await this.resources.ensureLoaded("whisper");

    const audioUriResult = await this.resolveAudioAssetUri(p.audioFileName);
    if (typeof audioUriResult !== "string") return audioUriResult;

    try {
      const text = await transcribe({
        modelId: whisperModelId,
        audioChunk: audioUriResult,
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

  async metadataBatch(params: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string };
    const whisperModelId = await this.resources.ensureLoaded("whisper");
    const audioUriResult = await this.resolveAudioAssetUri(p.audioFileName);
    if (typeof audioUriResult !== "string") return audioUriResult;

    try {
      const segments = await transcribe({
        modelId: whisperModelId,
        audioChunk: audioUriResult,
        metadata: true,
      });
      return validateSegments(segments);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Metadata batch failed: ${errorMsg}` };
    }
  }

  async metadataStreaming(params: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string } & MetadataStreamOptions;
    const whisperModelId = await this.resources.ensureLoaded("whisper");

    const audioBytesResult = await this.loadAudioBytes(p.audioFileName);
    if (!(audioBytesResult instanceof Uint8Array)) return audioBytesResult;

    return runMetadataStreamDuplex(whisperModelId, audioBytesResult, {
      ...(p.trailingSilenceMs !== undefined && {
        trailingSilenceMs: p.trailingSilenceMs,
      }),
      ...(p.chunkMs !== undefined && { chunkMs: p.chunkMs }),
    });
  }
}
