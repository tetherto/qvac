import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  CancellationExecutor,
  type TranscribeCancelParams,
} from "../../shared/executors/cancellation-executor.js";
import {
  cancelBroadTranscribe,
  cancelByRequestIdTranscribe,
} from "../../cancellation-tests.js";
import { resolveBundledAssetUri } from "../asset-uri.js";

interface AudioAssetsModule {
  audio: Record<string, number>;
}

export class MobileCancellationExecutor extends CancellationExecutor {
  protected override handlers = {
    ...this.buildSharedHandlers(),
    [cancelBroadTranscribe.testId]: this.transcribeBroad.bind(this),
    [cancelByRequestIdTranscribe.testId]: this.transcribeTargeted.bind(this),
  } as never;

  private audio: Record<string, number> | null = null;

  async transcribeBroad(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const audioPath = await this.resolveAudio(params.audioFileName);
    if (typeof audioPath !== "string") return audioPath;
    return this.transcribeWithCancel(audioPath, "broad", params.cancelAfterMs);
  }

  async transcribeTargeted(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const audioPath = await this.resolveAudio(params.audioFileName);
    if (typeof audioPath !== "string") return audioPath;
    return this.transcribeWithCancel(audioPath, "requestId", params.cancelAfterMs);
  }

  private async resolveAudio(audioFileName: string): Promise<string | TestResult> {
    const audio = await this.loadAudioAssets();
    const assetModule = audio[audioFileName];
    if (!assetModule) {
      return { passed: false, output: `Audio file not bundled: ${audioFileName}` };
    }
    return resolveBundledAssetUri(assetModule);
  }

  private async loadAudioAssets(): Promise<Record<string, number>> {
    if (!this.audio) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const mod = (await import("../../../../assets")) as AudioAssetsModule;
      this.audio = mod.audio;
    }
    return this.audio;
  }
}
