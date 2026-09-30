import type { QvacResponse } from "@qvac/infer-base";

import {
  ParakeetInterface,
  type ParakeetBinding,
  type ParakeetConfigurationParams,
} from "../parakeet/parakeet";
import {
  ERR_CODES,
  ERR_CODES_PARAKEET,
  QvacErrorAddonASRGgml,
} from "../../lib/error";
import { END_OF_INPUT } from "../../lib/constants";
import { normalizeAudioStream } from "../../lib/audio";
import type {
  ASRRunOutput,
  AudioInput,
  BackendInfo,
} from "../../lib/types";
import type {
  ASRGgmlFiles,
  ASRRunOptions,
  AsrDriver,
  DriverContext,
  NormalizedAudioStream,
  StreamingSession,
} from "../types";

export const ENGINE_MOSS_TRANSCRIBE = "moss-transcribe" as const;

/** MOSS-Transcribe-Diarize load-time configuration. */
export interface MossTranscribeConfig {
  /** Maximum CPU threads for inference (0 lets the engine pick). */
  maxThreads?: number;
  /** Enable the linked ggml GPU backend (Metal / Vulkan / OpenCL / CUDA). */
  useGPU?: boolean;
  /**
   * Directory containing dynamically-loaded ggml backend libraries. Defaults
   * to the package's own `prebuilds/` folder.
   */
  backendsDir?: string;
}

/** MOSS-Transcribe-Diarize branch of the discriminated engine-config union. */
export interface MossTranscribeEngineConfig {
  engine: typeof ENGINE_MOSS_TRANSCRIBE;
  mossTranscribeConfig?: MossTranscribeConfig;
}

/**
 * Per-call MOSS-Transcribe-Diarize options for `run(audio, options)`. Each is
 * optional; unset fields keep the model's defaults.
 */
export interface MossTranscribeRunOptions {
  /**
   * Names, brands and domain terms likely to appear in the audio; the model
   * spells them as given. Up to 64 entries of up to 64 UTF-8 bytes each.
   */
  hotwords?: string[];
  /** Replaces the default transcription instruction (excludes `hotwords`). */
  prompt?: string;
  /** Bound on generated tokens (0 or unset = model default). */
  maxNewTokens?: number;
}

const MOSS_CONFIG_KEYS: readonly string[] = ["maxThreads", "useGPU", "backendsDir"];
const MOSS_RUN_OPTION_KEYS: readonly string[] = ["hotwords", "prompt", "maxNewTokens"];
const MAX_HOTWORDS = 64;
const MAX_HOTWORD_BYTES = 64;
const ONE_BYTE_LIMIT = 0x80;
const TWO_BYTE_LIMIT = 0x800;
const THREE_BYTE_LIMIT = 0x10000;
const MAX_PROMPT_BYTES = 8192;
const MAX_NATIVE_INT = 2147483647;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function invalidRunOption(adds: string): QvacErrorAddonASRGgml {
  return new QvacErrorAddonASRGgml({ code: ERR_CODES_PARAKEET.INVALID_CONFIG, adds });
}

function utf8Bytes(codePoint: number): number {
  if (codePoint < ONE_BYTE_LIMIT) return 1;
  if (codePoint < TWO_BYTE_LIMIT) return 2;
  return codePoint < THREE_BYTE_LIMIT ? 3 : 4;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    bytes += utf8Bytes(character.codePointAt(0) ?? 0);
  }
  return bytes;
}

function isHotword(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= MAX_HOTWORD_BYTES;
}

function assertHotwords(hotwords: unknown): void {
  if (hotwords === undefined) return;
  if (!Array.isArray(hotwords) || hotwords.length > MAX_HOTWORDS || !hotwords.every(isHotword)) {
    throw invalidRunOption(
      `hotwords must be an array of up to ${MAX_HOTWORDS} non-empty strings of at most ` +
        `${MAX_HOTWORD_BYTES} UTF-8 bytes`,
    );
  }
}

function assertPrompt(prompt: unknown, hotwords: unknown): void {
  if (prompt === undefined) return;
  if (typeof prompt !== "string" || utf8Length(prompt) > MAX_PROMPT_BYTES) {
    throw invalidRunOption(`prompt must be a string of at most ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  if (hotwords !== undefined) {
    throw invalidRunOption("prompt replaces the default instruction and cannot be combined with hotwords");
  }
}

function assertMaxNewTokens(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_NATIVE_INT) {
    throw invalidRunOption(`maxNewTokens must be an integer in [0, ${MAX_NATIVE_INT}]`);
  }
}

function assertKnownRunOptions(options: Record<string, unknown>): void {
  for (const key of Object.keys(options)) {
    if (!MOSS_RUN_OPTION_KEYS.includes(key)) {
      throw invalidRunOption(`${key} is not a valid moss-transcribe run option`);
    }
  }
}

/** Validates the per-call options and returns the fields the native job reads. */
export function mossTranscribeJobFields(options: ASRRunOptions | null = {}): Record<string, unknown> {
  const fields = (options ?? {}) as Record<string, unknown>;
  assertKnownRunOptions(fields);
  assertHotwords(fields.hotwords);
  assertPrompt(fields.prompt, fields.hotwords);
  assertMaxNewTokens(fields.maxNewTokens);
  const present = MOSS_RUN_OPTION_KEYS.filter((key) => fields[key] !== undefined);
  return Object.fromEntries(present.map((key) => [key, fields[key]]));
}

/**
 * Returns an ArrayBuffer covering exactly the chunk's samples. Guards
 * against Float32Array views whose backing buffer is larger than the view.
 */
function chunkBuffer(chunk: Float32Array): ArrayBuffer {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk.buffer as ArrayBuffer;
  }
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
}

/**
 * MOSS-Transcribe-Diarize engine driver: one pass over a whole recording
 * that returns timestamped, speaker-labelled segments. Backed by the
 * speech-cpp parakeet engine's MOSS transcriber through the shared native
 * binding; there is no streaming and no native reload.
 */
export class MossTranscribeDriver implements AsrDriver {
  readonly engineType = ENGINE_MOSS_TRANSCRIBE;
  readonly supportsReload = false;

  addon?: ParakeetInterface;
  params: MossTranscribeConfig;

  private readonly ctx: DriverContext;
  private readonly _files: { model: string };

  constructor(ctx: DriverContext, files: ASRGgmlFiles, config: MossTranscribeEngineConfig) {
    this.ctx = ctx;
    this._files = { model: files.model };
    this.params = config.mossTranscribeConfig || {};
  }

  validateConfig(): void {
    for (const key of Object.keys(this.params)) {
      if (!MOSS_CONFIG_KEYS.includes(key)) {
        throw new QvacErrorAddonASRGgml({
          code: ERR_CODES_PARAKEET.INVALID_CONFIG,
          adds: `${key} is not a valid parameter for mossTranscribeConfig`,
        });
      }
    }
  }

  normalizeAudio(input: AudioInput): NormalizedAudioStream {
    return normalizeAudioStream(input, "s16le");
  }

  async load(): Promise<void> {
    const configurationParams = this._buildConfigurationParams();
    this.ctx.logger.info("Creating MOSS-Transcribe addon with configuration:", configurationParams);
    this.addon = this._createAddon(configurationParams);
    await this.addon.activate();
  }

  async unload(): Promise<void> {
    if (this.addon) await this.addon.destroyInstance();
  }

  reload(): Promise<void> {
    return Promise.reject(
      new QvacErrorAddonASRGgml({ code: ERR_CODES.NOT_SUPPORTED, adds: "reload (moss-transcribe)" }),
    );
  }

  async cancelActive(jobId?: number): Promise<void> {
    if (this.addon?.cancel) await this.addon.cancel(jobId);
    if (this.ctx.job.active) {
      this.ctx.job.fail(new QvacErrorAddonASRGgml(ERR_CODES_PARAKEET.JOB_CANCELLED));
    }
  }

  async status(): Promise<string> {
    if (!this.addon?.status) {
      throw new QvacErrorAddonASRGgml({
        code: ERR_CODES_PARAKEET.FAILED_TO_GET_STATUS,
        adds: "addon is not loaded",
      });
    }
    return await this.addon.status();
  }

  getBackendInfo(): BackendInfo | null {
    return this.addon?.getBackendInfo?.() ?? null;
  }

  run(audio: NormalizedAudioStream, options: ASRRunOptions = {}): Promise<QvacResponse<ASRRunOutput>> {
    const job = mossTranscribeJobFields(options);
    const response = this.ctx.job.start() as QvacResponse<ASRRunOutput>;
    void this._pumpBatchAudio(audio, job).catch((error: unknown) => {
      this.ctx.job.fail(asError(error));
    });
    return Promise.resolve(response);
  }

  createStreamingSession(): Promise<StreamingSession> {
    return Promise.reject(
      new QvacErrorAddonASRGgml({
        code: ERR_CODES.NOT_SUPPORTED,
        adds: "runStreaming (moss-transcribe transcribes whole recordings; use run())",
      }),
    );
  }

  async _pumpBatchAudio(audio: NormalizedAudioStream, job: Record<string, unknown>): Promise<void> {
    const addon = this._requireAddon();
    for await (const chunk of audio) {
      if (!this.ctx.job.active) return;
      await addon.append({ type: "audio", data: chunkBuffer(chunk) });
    }
    if (!this.ctx.job.active) return;
    await addon.append({ type: END_OF_INPUT, job });
  }

  _buildConfigurationParams(): ParakeetConfigurationParams {
    return {
      engineType: ENGINE_MOSS_TRANSCRIBE,
      modelPath: this._files.model || "",
      maxThreads: this.params.maxThreads ?? 0,
      useGPU: this.params.useGPU === true,
      backendsDir: this.params.backendsDir,
    };
  }

  _createAddon(configurationParams: ParakeetConfigurationParams): ParakeetInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("../../binding.js") as ParakeetBinding;
    return new ParakeetInterface(
      binding,
      configurationParams,
      this._outputCallback.bind(this),
      this.ctx.logger.info.bind(this.ctx.logger),
    );
  }

  private _outputCallback(_addon: unknown, event: unknown, _jobId: number, data: unknown, error: unknown): void {
    if (event === "Error") {
      this.ctx.job.fail(asError(error));
      return;
    }
    if (event === "Output") {
      this.ctx.job.output(data);
      return;
    }
    if (event === "JobEnded") {
      if (this.ctx.enableStats) this.ctx.job.end(data);
      else this.ctx.job.end();
    }
  }

  private _requireAddon(): ParakeetInterface {
    if (!this.addon) {
      throw new Error("MOSS-Transcribe addon is not loaded");
    }
    return this.addon;
  }
}
