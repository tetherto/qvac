import { transcribeStream } from "@qvac/sdk";
import type { TestResult } from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import {
  runTranscribeStreamEventsTest,
  type TranscribeStreamEventsParams,
} from "../../shared/transcribe-stream-events-runner.js";
import { transcribeStreamEventsTests } from "../../transcribe-stream-events-tests.js";

interface BaseParams extends TranscribeStreamEventsParams {
  audioFileName: string;
}

export class MobileTranscribeStreamEventsExecutor extends ModelAssetExecutor<
  typeof transcribeStreamEventsTests
> {
  pattern = /^transcribe-stream-events-/;
  protected handlers = {};
  protected defaultHandler = this.run.bind(this);

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

  private async loadAudioBytes(audioFileName: string): Promise<Uint8Array> {
    const audio = await this.loadAudioAssets();
    const assetModule = audio[audioFileName];
    if (!assetModule) {
      throw new Error(`Audio fixture not found in bundled assets: ${audioFileName}`);
    }
    // @ts-ignore - expo-asset is a peer dependency available in mobile context
    const { Asset } = await import("expo-asset");
    const asset = Asset.fromModule(assetModule);
    asset.downloaded = false;
    await asset.downloadAsync();
    const uri: string = asset.localUri || asset.uri;
    if (!uri) {
      throw new Error(`Failed to resolve asset: ${asset.name ?? audioFileName}`);
    }
    const fileUri = uri.startsWith("file://") ? uri : `file://${uri}`;
    // @ts-ignore - expo-file-system is a peer dependency available in mobile context
    const { File } = await import("expo-file-system");
    return await new File(fileUri).bytes();
  }

  private async run(
    testId: string,
    params: unknown,
  ): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("whisper");

    if (testId === "transcribe-stream-events-invalid") {
      try {
        await transcribeStream({
          modelId,
          emitVadEvents: p.emitVadEvents as true,
          ...(p.endOfTurnSilenceMs !== undefined && {
            endOfTurnSilenceMs: p.endOfTurnSilenceMs,
          }),
        });
        return {
          passed: false,
          output: `expected transcribeStream to reject endOfTurnSilenceMs=${p.endOfTurnSilenceMs}`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/endOfTurnSilenceMs|nonnegative|invalid/i.test(msg)) {
          return { passed: true, output: msg };
        }
        return {
          passed: false,
          output: `unexpected error message for invalid endOfTurnSilenceMs: ${msg}`,
        };
      }
    }

    const bytes = await this.loadAudioBytes(p.audioFileName);
    const mode =
      testId === "transcribe-stream-events-disabled"
        ? "events-disabled"
        : "events-emitted";
    return runTranscribeStreamEventsTest(modelId, bytes, p, mode);
  }
}
