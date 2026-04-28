import { textToSpeech } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite/mobile";
import type { ResourceManager } from "../../shared/resource-manager.js";
import { ModelAssetExecutor } from "./model-asset-executor.js";
import { ttsTests } from "../../tts-tests.js";

type TtsParams = { text: string; stream?: boolean; sentenceStream?: boolean };
type TtsResult = ReturnType<typeof textToSpeech>;

export class MobileTtsExecutor extends ModelAssetExecutor<typeof ttsTests> {
  pattern = /^tts-/;

  protected handlers = Object.fromEntries(
    ttsTests.map((test) => {
      const params = test.params as TtsParams;
      const dep = test.testId.startsWith("tts-supertonic-") ? "tts-supertonic" : "tts-chatterbox";
      if (params.stream && params.sentenceStream) {
        return [test.testId, this.makeSentenceStream(dep)];
      }
      if (params.stream) {
        return [test.testId, this.makeStreaming(dep)];
      }
      const isEmptyTest = !params.text || params.text.trim().length === 0;
      return [test.testId, this.makeNonStreaming(dep, isEmptyTest)];
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
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: "text",
          stream: false,
        });

        const audioBuffer = await result.buffer;
        const sampleCount = audioBuffer?.length ?? 0;

        return ValidationHelpers.validate(
          isEmptyTest
            ? (sampleCount === 0 ? "handled gracefully - empty buffer" : `generated ${sampleCount} samples`)
            : `generated ${sampleCount} samples`,
          expectation,
        );
      } catch (error) {
        if (isEmptyTest) {
          return ValidationHelpers.validate(`handled gracefully: ${error}`, expectation);
        }
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS error: ${errorMsg}` };
      }
    };
  }

  private makeSentenceStream(dep: string) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: "text",
          stream: true,
          sentenceStream: true,
        });

        if (!result.chunkUpdates) {
          return {
            passed: false,
            output: "TTS sentence-stream did not return chunkUpdates iterator",
          };
        }

        let totalChunks = 0;
        let totalSamples = 0;
        for await (const chunk of result.chunkUpdates) {
          totalChunks++;
          totalSamples += chunk.buffer.length;
        }

        await result.done;

        if (totalChunks === 0 || totalSamples === 0) {
          return {
            passed: false,
            output: `TTS sentence-stream produced no audio (chunks=${totalChunks}, samples=${totalSamples})`,
          };
        }

        return ValidationHelpers.validate(
          `sentence-streamed ${totalChunks} chunks (${totalSamples} samples)`,
          expectation,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS sentence-stream error: ${errorMsg}` };
      }
    };
  }

  private makeStreaming(dep: string) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: "text",
          stream: true,
        });

        let totalSamples = 0;
        if (result.bufferStream && typeof result.bufferStream[Symbol.asyncIterator] === "function") {
          for await (const _sample of result.bufferStream) {
            totalSamples++;
          }
        } else if (result.buffer) {
          const buf = await result.buffer;
          totalSamples = buf?.length ?? 0;
        }

        return ValidationHelpers.validate(`streamed ${totalSamples} samples`, expectation);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS streaming error: ${errorMsg}` };
      }
    };
  }
}
