import { transcribeStream } from "@qvac/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import {
  runTranscribeStreamEventsTest,
  type TranscribeStreamEventsParams,
} from "../../shared/transcribe-stream-events-runner.js";
import { transcribeStreamEventsTests } from "../../transcribe-stream-events-tests.js";

interface BaseParams extends TranscribeStreamEventsParams {
  audioFileName: string;
}

export class TranscribeStreamEventsExecutor extends AbstractModelExecutor<
  typeof transcribeStreamEventsTests
> {
  pattern = /^transcribe-stream-events-/;

  protected handlers = {
    "transcribe-stream-events-happy": this.runHappy.bind(this),
    "transcribe-stream-events-disabled": this.runDisabled.bind(this),
    "transcribe-stream-events-invalid": this.runInvalid.bind(this),
  } as never;

  private async loadAudioBytes(audioFileName: string): Promise<Uint8Array> {
    const audioPath = path.resolve(
      process.cwd(),
      "assets/audio",
      audioFileName,
    );
    const buf = await fs.readFile(audioPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async runHappy(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("whisper");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runTranscribeStreamEventsTest(modelId, bytes, p, "events-emitted");
  }

  async runDisabled(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("whisper");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runTranscribeStreamEventsTest(modelId, bytes, p, "events-disabled");
  }

  async runInvalid(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("whisper");
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
}
