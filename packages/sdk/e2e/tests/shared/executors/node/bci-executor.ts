import { bciTranscribe, bciTranscribeStream } from "@qvac/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../abstract-model-executor.js";
import { bciTests } from "../../../bci-tests.js";

// Feed the neural buffer to the duplex session in fixed-size chunks to
// exercise the sliding-window driver across multiple writes.
const STREAM_CHUNK_SIZE = 64 * 1024;

export class BciExecutor extends AbstractModelExecutor<typeof bciTests> {
  pattern = /^bci-transcribe-/;

  protected handlers = {
    "bci-transcribe-batch": this.runBatch.bind(this),
    "bci-transcribe-stream": this.runStream.bind(this),
    "bci-transcribe-error-missing-file": this.runMissingFile.bind(this),
  } as never;

  private neuralPath(neuralFileName: string): string {
    return path.resolve(process.cwd(), "assets/neural", neuralFileName);
  }

  async runBatch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { neuralFileName: string };
    const exp = expectation as Expectation;
    const modelId = await this.resources.ensureLoaded("bci");

    try {
      const text = await bciTranscribe({
        modelId,
        neuralData: this.neuralPath(p.neuralFileName),
      });
      return ValidationHelpers.validate(text.trim(), exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `BCI transcription failed: ${errorMsg}` };
    }
  }

  async runStream(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { neuralFileName: string };
    const exp = expectation as Expectation;
    const modelId = await this.resources.ensureLoaded("bci");

    try {
      const buf = await fs.readFile(this.neuralPath(p.neuralFileName));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

      const session = await bciTranscribeStream({ modelId, emit: "full" });

      // Drain concurrently with writing so the sliding window can decode as
      // chunks arrive instead of stalling until end().
      const consume = (async () => {
        let transcript = "";
        for await (const text of session) {
          transcript += text;
        }
        return transcript;
      })();

      for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_SIZE) {
        session.write(bytes.subarray(offset, offset + STREAM_CHUNK_SIZE));
      }
      session.end();

      const transcript = await consume;
      return ValidationHelpers.validate(transcript.trim(), exp);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `BCI stream failed: ${errorMsg}` };
    }
  }

  async runMissingFile(
    params: unknown,
    expectation: unknown,
  ): Promise<TestResult> {
    const p = params as { neuralFileName: string };
    const exp = expectation as Expectation;
    const modelId = await this.resources.ensureLoaded("bci");

    try {
      await bciTranscribe({
        modelId,
        neuralData: this.neuralPath(p.neuralFileName),
      });
      return {
        passed: false,
        output: "Expected error but BCI transcription succeeded",
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return ValidationHelpers.validate(errorMsg, exp);
    }
  }
}
