import { textToSpeech } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { ttsTests } from "../../tts-tests.js";

export class TtsExecutor extends AbstractModelExecutor<typeof ttsTests> {
  pattern = /^tts-/;

    protected handlers = Object.fromEntries(
      ttsTests.map((test) => {
        const params = test.params as { stream?: boolean };
        const dep = test.metadata?.dependency || "tts-chatterbox";
        if (params.stream) {
          return [test.testId, this.makeStreaming(dep)];
        }
        return [test.testId, this.makeNonStreaming(dep, !test.params.text || (test.params.text as string).trim().length === 0)];
      }),
    ) as never;

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
