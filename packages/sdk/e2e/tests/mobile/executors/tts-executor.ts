import { textToSpeech } from '@qvac/sdk'
import {
  ValidationHelpers,
  type TestResult,
  type Expectation
} from '@tetherto/qvac-test-suite/mobile'
import type { ResourceManager } from '../../shared/resource-manager.js'
import { ModelAssetExecutor } from './model-asset-executor.js'
import { ttsTests } from '../../tts-tests.js'

type TtsParams = { text: string; stream?: boolean; sentenceStream?: boolean }
type TtsResult = ReturnType<typeof textToSpeech>

export class MobileTtsExecutor extends ModelAssetExecutor<typeof ttsTests> {
  pattern = /^tts-/

  protected handlers = Object.fromEntries(
    ttsTests.map((test) => {
      const params = test.params as TtsParams;
      const dep = test.metadata?.dependency || "tts-chatterbox";
      if (test.testId === "tts-supertonic-output-sample-rate") {
        return [test.testId, this.makeOutputSampleRateComparison()];
      }
      if (test.testId === "tts-supertonic-enhanced") {
        return [test.testId, this.makeEnhanced(dep)];
      }
      if (params.stream && params.sentenceStream) {
        return [test.testId, this.makeSentenceStream(dep)]
      }
      if (params.stream) {
        return [test.testId, this.makeStreaming(dep)]
      }
      const isEmptyTest = !params.text || params.text.trim().length === 0
      return [test.testId, this.makeNonStreaming(dep, isEmptyTest)]
    })
  ) as never
  protected defaultHandler = undefined

  constructor(resources: ResourceManager) {
    super(resources)
  }

  private async countSamples(modelId: string, text: string): Promise<number> {
    const result: TtsResult = textToSpeech({
      modelId,
      text,
      inputType: "text",
      stream: false,
    });
    const audioBuffer = await result.buffer;
    return audioBuffer?.length ?? 0;
  }

  // LavaSR enhancer + denoiser happy path: the enhancer forces 48 kHz internally,
  // but that rate isn't observable through the public TTS result, so assert the
  // two-stage chain produces a non-empty buffer end to end.
  private makeEnhanced(dep: string) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep);

      try {
        const samples = await this.countSamples(modelId, params.text);
        if (samples === 0) {
          return {
            passed: false,
            output: "LavaSR enhanced synthesis produced no audio (0 samples)",
          };
        }
        return ValidationHelpers.validate(
          `LavaSR enhanced synthesis produced ${samples} samples`,
          expectation,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS enhanced error: ${errorMsg}` };
      }
    };
  }

  // outputSampleRate happy path: run the same text through the native-rate
  // (44.1 kHz) and 8 kHz Supertonic resources. Sample count scales with the
  // rate, so native must produce far more samples (~5.5x). A >=3x floor clears
  // any per-load duration jitter while still proving the 8 kHz resample took
  // effect. Only the ratio-pass branch emits `outputSampleRate-verified`.
  private makeOutputSampleRateComparison() {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const nativeId = await this.resources.ensureLoaded("tts-supertonic");
      const downId = await this.resources.ensureLoaded("tts-supertonic-8k");

      try {
        const nativeSamples = await this.countSamples(nativeId, params.text);
        const downSamples = await this.countSamples(downId, params.text);

        if (nativeSamples === 0 || downSamples === 0) {
          return {
            passed: false,
            output: `outputSampleRate comparison produced empty audio (native=${nativeSamples}, down=${downSamples})`,
          };
        }

        const ratio = nativeSamples / downSamples;
        if (ratio < 3) {
          return {
            passed: false,
            output: `outputSampleRate ratio too low: native/down=${ratio.toFixed(2)} (native=${nativeSamples} @44100, down=${downSamples} @8000)`,
          };
        }

        return ValidationHelpers.validate(
          `outputSampleRate-verified: native=${nativeSamples} @44100 vs down=${downSamples} @8000 (ratio ${ratio.toFixed(2)}, samples compared)`,
          expectation,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { passed: false, output: `TTS outputSampleRate error: ${errorMsg}` };
      }
    };
  }

  private makeNonStreaming(dep: string, isEmptyTest: boolean) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep)

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: 'text',
          stream: false
        })

        const audioBuffer = await result.buffer
        const sampleCount = audioBuffer?.length ?? 0

        return ValidationHelpers.validate(
          isEmptyTest
            ? sampleCount === 0
              ? 'handled gracefully - empty buffer'
              : `generated ${sampleCount} samples`
            : `generated ${sampleCount} samples`,
          expectation
        )
      } catch (error) {
        if (isEmptyTest) {
          return ValidationHelpers.validate(`handled gracefully: ${error}`, expectation)
        }
        const errorMsg = error instanceof Error ? error.message : String(error)
        return { passed: false, output: `TTS error: ${errorMsg}` }
      }
    }
  }

  private makeSentenceStream(dep: string) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep)

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: 'text',
          stream: true,
          sentenceStream: true
        })

        if (!result.chunkUpdates) {
          return {
            passed: false,
            output: 'TTS sentence-stream did not return chunkUpdates iterator'
          }
        }

        let totalChunks = 0
        let totalSamples = 0
        for await (const chunk of result.chunkUpdates) {
          totalChunks++
          totalSamples += chunk.buffer.length
        }

        await result.done

        if (totalChunks === 0 || totalSamples === 0) {
          return {
            passed: false,
            output: `TTS sentence-stream produced no audio (chunks=${totalChunks}, samples=${totalSamples})`
          }
        }

        return ValidationHelpers.validate(
          `sentence-streamed ${totalChunks} chunks (${totalSamples} samples)`,
          expectation
        )
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return { passed: false, output: `TTS sentence-stream error: ${errorMsg}` }
      }
    }
  }

  private makeStreaming(dep: string) {
    return async (params: TtsParams, expectation: Expectation): Promise<TestResult> => {
      const modelId = await this.resources.ensureLoaded(dep)

      try {
        const result: TtsResult = textToSpeech({
          modelId,
          text: params.text,
          inputType: 'text',
          stream: true
        })

        let totalSamples = 0
        if (
          result.bufferStream &&
          typeof result.bufferStream[Symbol.asyncIterator] === 'function'
        ) {
          for await (const _sample of result.bufferStream) {
            totalSamples++
          }
        } else if (result.buffer) {
          const buf = await result.buffer
          totalSamples = buf?.length ?? 0
        }

        return ValidationHelpers.validate(`streamed ${totalSamples} samples`, expectation)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return { passed: false, output: `TTS streaming error: ${errorMsg}` }
      }
    }
  }
}
