import { textToSpeech } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { ttsTests } from "../../tts-tests.js";

export class MobileTtsExecutor extends ModelAssetExecutor<typeof ttsTests> {
  pattern = /^tts-/;

  protected handlers = Object.fromEntries(
    ttsTests.map((test) => {
      const params = test.params as { stream?: boolean };
      const dep = test.testId.startsWith("tts-supertonic-") ? "tts-supertonic" : "tts-chatterbox";
      if (params.stream) {
        return [test.testId, this.makeStreaming(dep)];
      }
      return [test.testId, this.makeNonStreaming(dep, !test.params.text || (test.params.text as string).trim().length === 0)];
    }),
  ) as never;
  protected defaultHandler = undefined;

  private audioAssets: Record<string, number> | null = null;
  private referenceAudioPatched = false;

  constructor(resources: ResourceManager) {
    super(resources);
  }

  async setup(testId: string, context: unknown) {
    if (!this.referenceAudioPatched) {
      await this.patchChatterboxReferenceAudio();
      this.referenceAudioPatched = true;
    }
    await super.setup(testId, context);
  }

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import("../../../../assets");
      this.audioAssets = assets.audio;
    }
    return this.audioAssets!;
  }

  /**
   * Resolve the reference audio asset URI and patch the tts-chatterbox
   * resource definition config. Must run before the first ensureLoaded()
   * call so loadModel() receives the referenceAudioSrc.
   */
  private async patchChatterboxReferenceAudio() {
    try {
      const audio = await this.loadAudioAssets();
      const assetModule = audio["transcription-short-wav.wav"];
      if (!assetModule) return;

      const audioUri = await this.resolveAsset(assetModule);
      const def = (this.resources as unknown as { definitions: Map<string, { config?: Record<string, unknown> }> }).definitions.get("tts-chatterbox");
      if (def?.config) {
        def.config.referenceAudioSrc = audioUri;
      }
    } catch (e) {
      console.warn("Failed to resolve chatterbox reference audio:", e);
    }
  }

  private makeNonStreaming(dep: string, isEmptyTest: boolean) {
    return async (params: unknown, expectation: unknown): Promise<TestResult> => {
      const p = params as { text: string };
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const result = textToSpeech({
          modelId,
          text: p.text,
          inputType: "text",
          stream: false,
        });

        const audioBuffer = await (result as unknown as { buffer: Promise<Buffer> }).buffer;
        const sampleCount = audioBuffer?.length ?? 0;

        return ValidationHelpers.validate(
          isEmptyTest
            ? (sampleCount === 0 ? "handled gracefully - empty buffer" : `generated ${sampleCount} samples`)
            : `generated ${sampleCount} samples`,
          expectation as Expectation,
        );
      } catch (error) {
        if (isEmptyTest) {
          return ValidationHelpers.validate(`handled gracefully: ${error}`, expectation as Expectation);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS error: ${errorMsg}` };
      }
    };
  }

  private makeStreaming(dep: string) {
    return async (params: unknown, expectation: unknown): Promise<TestResult> => {
      const p = params as { text: string };
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const result = textToSpeech({
          modelId,
          text: p.text,
          inputType: "text",
          stream: true,
        });

        let totalSamples = 0;
        const rs = result as unknown as { bufferStream: AsyncIterable<unknown>; buffer?: Promise<Buffer> };

        if (rs.bufferStream && typeof (rs.bufferStream as never)[Symbol.asyncIterator] === "function") {
          for await (const _sample of rs.bufferStream) {
            totalSamples++;
          }
        } else if (rs.buffer) {
          const buf = await rs.buffer;
          totalSamples = buf?.length ?? 0;
        }

        return ValidationHelpers.validate(`streamed ${totalSamples} samples`, expectation as Expectation);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS streaming error: ${errorMsg}` };
      }
    };
  }
}
