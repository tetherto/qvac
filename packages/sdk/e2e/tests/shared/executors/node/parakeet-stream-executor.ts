import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestResult } from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "../abstract-model-executor.js";
import {
  runParakeetStreamHappy,
  runParakeetStreamMetadataRejected,
  runParakeetStreamEou,
  runParakeetStreamDestroyMidUtterance,
  runParakeetStreamIteratorThrow,
  type ParakeetStreamParams,
} from "../../parakeet-stream-runner.js";
import { parakeetStreamTests } from "../../../parakeet-stream-tests.js";

interface BaseParams extends ParakeetStreamParams {
  audioFileName: string;
}

export class ParakeetStreamExecutor extends AbstractModelExecutor<
  typeof parakeetStreamTests
> {
  pattern = /^parakeet-stream-/;

  protected handlers = {
    "parakeet-stream-happy": this.runHappy.bind(this),
    "parakeet-stream-metadata-rejected": this.runMetadataRejected.bind(this),
    "parakeet-stream-eou": this.runEou.bind(this),
    "parakeet-stream-destroy-mid-utterance": this.runDestroyMidUtterance.bind(
      this,
    ),
    "parakeet-stream-iterator-throw": this.runIteratorThrow.bind(this),
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
    const modelId = await this.resources.ensureLoaded("parakeet-tdt");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runParakeetStreamHappy(modelId, bytes, p);
  }

  async runMetadataRejected(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("parakeet-tdt");
    return runParakeetStreamMetadataRejected(modelId);
  }

  async runEou(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("parakeet-eou");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runParakeetStreamEou(modelId, bytes, p);
  }

  async runDestroyMidUtterance(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("parakeet-tdt");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runParakeetStreamDestroyMidUtterance(modelId, bytes, p);
  }

  async runIteratorThrow(params: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded("parakeet-tdt");
    const bytes = await this.loadAudioBytes(p.audioFileName);
    return runParakeetStreamIteratorThrow(modelId, bytes, p);
  }
}
