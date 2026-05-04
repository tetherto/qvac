import { textToSpeech } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { ttsTests } from "../../tts-tests.js";

type TtsParams = { text: string; stream?: boolean; sentenceStream?: boolean };
type TtsResult = ReturnType<typeof textToSpeech>;

export class TtsExecutor extends AbstractModelExecutor<typeof ttsTests> {
  pattern = /^tts-/;

  protected handlers = Object.fromEntries(
    ttsTests.map((test) => {
      const params = test.params as TtsParams;
      const dep = test.metadata?.dependency || "tts-chatterbox";
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

        // A passing run must produce at least one chunk with audio samples.
        // Previously the expectation only validated the return type was a
        // string, so a regression to a zero-chunk stream would have passed
        // silently. Fail explicitly here; the caller's contains-all
        // expectation further pins the happy-path string format.
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
