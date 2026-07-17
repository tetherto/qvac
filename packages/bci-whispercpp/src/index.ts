/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import path = require("bare-path");
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  QvacResponse,
  type JobHandler,
} from "@qvac/infer-base";

import { BCIInterface, type BCIBinding } from "./bci";
import { QvacErrorAddonBCI, ERR_CODES, errorMessage } from "./lib/error";
import { computeWER } from "./lib/wer";
import {
  toUint8,
  sliceBody,
  buildWindowBuffer,
  stitchSegments,
  type TranscriptSegment,
} from "./lib/stream";
import {
  STREAM_HEADER_BYTES,
  CHANNELS_FIELD_OFFSET,
  FLOAT32_BYTES,
  ADDON_EVENT,
} from "./lib/constants";
import { type BCIConfigurationParams } from "./configChecker";

export interface BCIConfig {
  /**
   * Session day index used to select day-specific projection matrices in
   * bci-embedder.bin.
   *
   *   - `day_idx >= 0` (default `0`): apply the day projection; values beyond
   *     the available range are clamped at the native layer.
   *   - `day_idx === -1`: mel passthrough -- skip preprocessing and treat
   *     the input buffer as pre-computed 512-bin mel features in
   *     frame-major layout. Intended for parity testing against the Python
   *     reference, not production use.
   */
  day_idx?: number;
}

export interface WhisperConfig {
  language?: string;
  n_threads?: number;
  temperature?: number;
  suppress_nst?: boolean;
  suppress_blank?: boolean;
  duration_ms?: number;
  translate?: boolean;
  no_timestamps?: boolean;
  single_segment?: boolean;
  print_special?: boolean;
  print_progress?: boolean;
  print_realtime?: boolean;
  print_timestamps?: boolean;
  detect_language?: boolean;
  greedy_best_of?: number;
  beam_search_beam_size?: number;
}

export interface BCIWhispercppFiles {
  /** Absolute path to the BCI GGML model file. */
  model: string;
  /**
   * Optional path to the embedder weights file. When omitted the native
   * addon resolves `bci-embedder.bin` from the same directory as `model`.
   */
  embedder?: string;
}

export interface BCIWhispercppArgs {
  files: BCIWhispercppFiles;
  logger?: QvacLogger.LoggerInterface;
  opts?: {
    stats?: boolean;
  };
}

export interface BCIWhispercppConfig {
  whisperConfig?: WhisperConfig;
  bciConfig?: BCIConfig;
  contextParams?: {
    model?: string;
    use_gpu?: boolean;
    flash_attn?: boolean;
    gpu_device?: number;
  };
  miscConfig?: {
    caption_enabled?: boolean;
  };
  /**
   * Override the default prebuilds folder used to locate dynamically-
   * loaded ggml backend `.so` modules on Android. When omitted the
   * native side resolves to `<addon>/prebuilds`. Ignored on non-Android
   * targets. Mirrors `transcription-whispercpp 0.9.0`.
   */
  backendsDir?: string;
}

export interface BCIWhispercppState {
  configLoaded: boolean;
  destroyed: boolean;
}

/**
 * Options for {@link BCIWhispercpp.transcribeStream}.
 */
export interface StreamOpts {
  /** Decode window size in timesteps. Must be > 0 and <= MAX_WINDOW_TIMESTEPS. */
  windowTimesteps?: number;
  /** How far the window advances between decodes. Must be > 0 and < windowTimesteps. */
  hopTimesteps?: number;
  /** Whether each update carries only the newly-discovered tail ('delta') or the full running transcript ('full'). */
  emit?: "delta" | "full";
}

export type { TranscriptSegment };

interface NormalizedStreamOpts {
  windowTimesteps: number;
  hopTimesteps: number;
  emit: "delta" | "full";
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

type StreamWindowHandler = (
  event: string,
  data: unknown,
  error: unknown,
) => void;

type NeuralStreamInput =
  | AsyncIterable<unknown>
  | Iterable<unknown>
  | Uint8Array
  | Uint8Array[];

// Default prebuilds folder for dynamically-loaded ggml backend `.so`
// files. Consumed by the native addon on Android only (no-op
// elsewhere). The CMake build stages the per-arch backends into
// `<addon>/prebuilds/<bare_target>/<module_name>/`; the native side
// joins `backendsDir` with the compile-time `BACKENDS_SUBDIR` before
// calling `ggml_backend_load_all_from_path()`.
const PREBUILDS_DIR = path.join(__dirname, "prebuilds");

// Sliding-window streaming constants.
//
// The underlying whisper encoder accepts up to ~3000 timesteps of input per
// forward pass. We keep MAX_WINDOW_TIMESTEPS slightly below that ceiling so
// that edge-case window sizes (e.g. final flush of a partial window) always
// fit without a native-side truncation. Requests above this surface as
// WINDOW_TOO_LARGE so callers can react explicitly.
//
// DEFAULT_WINDOW_TIMESTEPS / DEFAULT_HOP_TIMESTEPS are chosen as a balanced
// first-step trade-off: a 1500-step window decodes quickly on commodity
// hardware, and a 500-step hop (~33% overlap) gives the word-stitcher
// enough overlap to deduplicate across boundaries without decoding the
// same audio ~2x. These numbers will be revisited when a segmentation
// model replaces the fixed-window heuristic.
//
// MAX_STITCH_WORDS bounds the suffix/prefix search in stitchSegments so
// the per-window merge stays O(maxWords^2) regardless of transcript length.
const DEFAULT_WINDOW_TIMESTEPS = 1500;
const DEFAULT_HOP_TIMESTEPS = 500;
const MAX_WINDOW_TIMESTEPS = 2900;
const MAX_STITCH_WORDS = 40;

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 *
 * Follows the same architecture as TranscriptionWhispercpp / LlmLlamacpp:
 * standalone class using createJobHandler + exclusiveRunQueue from
 * @qvac/infer-base.
 */
export class BCIWhispercpp {
  readonly logger: QvacLogger;
  addon: BCIInterface | null;
  state: BCIWhispercppState;
  opts: { stats?: boolean };

  private readonly _files: BCIWhispercppFiles;
  private readonly _config: BCIWhispercppConfig;
  private readonly _withExclusiveRun: RunExclusive;
  private _inferenceQueueWaiter: Promise<void>;
  private readonly _job: JobHandler;
  private _streamResponse: QvacResponse | null;
  private _streamWindowHandler: StreamWindowHandler | null;
  private _streamWindowReject: ((err: Error) => void) | null;
  private _streamDriverPromise: Promise<void> | null;
  private _streamAborted: boolean;

  constructor(
    { files, logger = undefined, opts = {} }: BCIWhispercppArgs,
    config: BCIWhispercppConfig = {},
  ) {
    if (!files || typeof files.model !== "string" || files.model.length === 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: "files.model is required",
      });
    }

    if (
      files.embedder !== undefined &&
      (typeof files.embedder !== "string" || files.embedder.length === 0)
    ) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: "files.embedder must be a non-empty string when provided",
      });
    }

    this._files = { model: files.model };
    if (typeof files.embedder === "string" && files.embedder.length > 0) {
      this._files.embedder = files.embedder;
    }
    this._config = config;
    this.opts = opts;
    this.logger = new QvacLogger(logger);
    this._withExclusiveRun = exclusiveRunQueue() as RunExclusive;
    this._inferenceQueueWaiter = Promise.resolve();
    this._job = createJobHandler({
      cancel: () => this.addon?.cancel(),
    });

    this.addon = null;
    this.state = {
      configLoaded: false,
      destroyed: false,
    };

    // Stream lifecycle state. A stream is considered active iff
    // `_streamResponse` is non-null; no separate boolean is needed. The
    // handler/reject pair is the side-channel `_outputCallback` uses to
    // divert per-window events to `_decodeWindow` while a stream is running.
    this._streamResponse = null;
    this._streamWindowHandler = null;
    this._streamWindowReject = null;
    this._streamDriverPromise = null;
    this._streamAborted = false;
  }

  /**
   * Abort any active stream: reject the in-flight window decode (if any),
   * clear the stream side-channel, and fail the outward-facing response.
   * Idempotent. Does NOT await the driver - callers that need the driver
   * to fully unwind (unload/destroy) should `await this._streamDriverPromise`
   * after calling this.
   */
  private _teardownActiveStream(reason: string): void {
    this._streamAborted = true;
    this._streamWindowHandler = null;
    if (this._streamWindowReject) {
      const rej = this._streamWindowReject;
      this._streamWindowReject = null;
      rej(new Error(reason));
    }
    if (this._streamResponse) {
      const r = this._streamResponse;
      this._streamResponse = null;
      r.failed(new Error(reason));
    }
  }

  getState(): BCIWhispercppState {
    return this.state;
  }

  async load(): Promise<void> {
    if (this.state.destroyed) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: "instance was destroyed",
      });
    }
    if (this.state.configLoaded) {
      this.logger.info("Reload requested - unloading existing model first");
      await this.unload();
    }
    await this._load();
    this.state.configLoaded = true;
  }

  private async _load(): Promise<void> {
    if (!fs.existsSync(this._files.model)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: this._files.model,
      });
    }

    if (this._files.embedder && !fs.existsSync(this._files.embedder)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: this._files.embedder,
      });
    }

    const whisperConfig: Record<string, unknown> = {
      language: "en",
      n_threads: 0,
      ...(this._config.whisperConfig ?? {}),
    };

    const configurationParams: BCIConfigurationParams = {
      contextParams: {
        model: this._files.model,
        ...(this._config.contextParams ?? {}),
      },
      whisperConfig,
      miscConfig: {
        caption_enabled: false,
        ...(this._config.miscConfig ?? {}),
      },
      // Override-only key. Native side falls back to `ggml_backend_load_all()`
      // (default search path) on Android when this is empty -- which fails
      // inside an APK with the standard packaging options that compress
      // native libs. Defaulting to the in-package prebuilds dir keeps
      // mobile builds working out of the box, parity with transcription-
      // whispercpp 0.9.0.
      backendsDir:
        typeof this._config.backendsDir === "string" &&
        this._config.backendsDir.length > 0
          ? this._config.backendsDir
          : PREBUILDS_DIR,
    };

    if (this._config.bciConfig) {
      configurationParams.bciConfig = this._config.bciConfig as Record<
        string,
        unknown
      >;
    }

    // Optional override. When provided, the native side loads the embedder
    // weights from this exact path instead of resolving `bci-embedder.bin`
    // next to the GGML model file. Mirrors the `backendsDir` override.
    if (this._files.embedder) {
      configurationParams.embedderPath = this._files.embedder;
    }

    if (this.state.destroyed) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: "instance was destroyed",
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as BCIBinding;
    try {
      this.addon = new BCIInterface(
        binding,
        configurationParams,
        this._outputCallback.bind(this),
        this.logger.info.bind(this.logger),
      );
    } catch (err) {
      this.addon = null;
      const configError = this._isConfigurationError(err);
      throw new QvacErrorAddonBCI({
        code: configError
          ? ERR_CODES.INVALID_CONFIG
          : ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }

    try {
      await this.addon.activate();
    } catch (err) {
      this.addon = null;
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: errorMessage(err),
        cause: err as Error,
      });
    }
    this.logger.info("BCI addon activated");
  }

  /**
   * Transcribe a neural signal from a binary file.
   * Convenience wrapper around transcribe().
   */
  async transcribeFile(filePath: string): Promise<QvacResponse> {
    const data = fs.readFileSync(filePath);
    return this.transcribe(new Uint8Array(data));
  }

  /**
   * Transcribe neural signal data (batch mode).
   * Returns a QvacResponse; use response.await() for the final output array,
   * response.onUpdate() for streaming updates, response.stats for runtime stats.
   */
  async transcribe(neuralData: Uint8Array): Promise<QvacResponse> {
    const addon = this._assertReadyForInference();
    return this._enqueueInference(async () => {
      const response = this._job.start();

      let accepted: boolean;
      try {
        accepted = await addon.runJob({ input: neuralData });
      } catch (err) {
        this._job.fail(err as Error);
        throw err;
      }
      if (!accepted) {
        const error = new QvacErrorAddonBCI({
          code: ERR_CODES.JOB_ALREADY_RUNNING,
        });
        this._job.fail(error);
        throw error;
      }

      const finalized = response.await();
      void finalized.catch(() => {});
      response.await = () => finalized;
      return response;
    });
  }

  /**
   * Incrementally transcribe a neural signal stream using a sliding window
   * over the existing batch `runJob` pipeline. Purely JS-side; no native
   * streaming hooks are used.
   *
   * Input shape (header semantics):
   *   [T (u32 LE), C (u32 LE), body bytes...]
   * In streaming mode the T field is required to be present for format
   * compatibility with batch inputs but is ignored; window sizing comes
   * from `streamOpts.windowTimesteps`. C must be non-zero.
   *
   * Stream input types accepted: async iterable, sync iterable, Uint8Array,
   * or chunk array. Each yielded chunk must be a Uint8Array / ArrayBuffer
   * view / ArrayBuffer / plain byte array.
   *
   * Emission contract: `response.onUpdate(...)` fires per window that
   * produced non-empty text.
   *   - emit:'delta' (default): update carries the trimmed native segments
   *     for the newly-discovered tail, preserving each segment's native
   *     fields (`text`, `t0`, `t1`, ...). Each segment is additionally
   *     annotated with `windowStartTimestep` (the absolute timestep at
   *     which its owning window began) so consumers can map window-local
   *     timestamps back to the stream timeline.
   *   - emit:'full': update carries a single `{ text }` entry with the
   *     full running transcript. Per-segment timestamps are NOT preserved
   *     in this mode because a cumulative segment timeline across windows
   *     cannot be reliably reconstructed from window-local timestamps.
   *
   * `response.await()` resolves once the input stream ends and the final
   * flush window decodes. `response.stats` is not populated for streams.
   */
  async transcribeStream(
    neuralStream: NeuralStreamInput,
    streamOpts: StreamOpts = {},
  ): Promise<QvacResponse> {
    this._assertReadyForInference();
    if (this._streamResponse !== null) {
      throw new QvacErrorAddonBCI({ code: ERR_CODES.STREAM_ALREADY_ACTIVE });
    }

    const opts = this._validateStreamOpts(streamOpts);
    const iterable = this._normalizeNeuralStream(neuralStream);

    return this._enqueueInference(() => {
      this._streamAborted = false;
      const response = new QvacResponse({
        cancelHandler: async () => {
          await this.cancel();
        },
      });
      this._streamResponse = response;

      const driver = this._runStreamDriver(iterable, opts, response)
        .catch((err: unknown) => {
          if (this._streamResponse === response) {
            this._streamResponse = null;
          }
          response.failed(err instanceof Error ? err : new Error(errorMessage(err)));
        })
        .finally(() => {
          if (this._streamDriverPromise === driver) {
            this._streamDriverPromise = null;
          }
        });
      this._streamDriverPromise = driver;

      return Promise.resolve(response);
    });
  }

  private async _runStreamDriver(
    iterable: AsyncIterable<unknown> | Iterable<unknown>,
    opts: NormalizedStreamOpts,
    response: QvacResponse,
  ): Promise<void> {
    let channels: number | null = null;
    let headerCarry: Uint8Array = new Uint8Array(0);
    const body: Uint8Array[] = [];
    let bodyBytes = 0;
    let bytesPerTimestep = 0;
    let windowStartTs = 0;
    let lastDecodedEndTs = 0;
    let mergedText = "";

    const decodeRange = async (startTs: number, windowTs: number) => {
      if (this._streamAborted) return;
      if (windowTs <= 0) return;
      const endTs = startTs + windowTs;
      if (endTs <= lastDecodedEndTs) return;

      const windowBody = sliceBody(
        body,
        bytesPerTimestep,
        startTs,
        endTs,
        bodyBytes,
      );
      const windowBuf = buildWindowBuffer(windowBody, channels as number, windowTs);

      this.logger.debug("Decoding stream window", {
        startTimestep: startTs,
        endTimestep: endTs,
        windowTimesteps: windowTs,
      });

      const segments = await this._decodeWindow(windowBuf);
      lastDecodedEndTs = endTs;

      const { deltaSegments, merged } = stitchSegments(
        mergedText,
        segments,
        MAX_STITCH_WORDS,
        startTs,
      );
      mergedText = merged;

      if (opts.emit === "full") {
        if (merged.length > 0) {
          response.updateOutput([{ text: merged }]);
        }
      } else if (deltaSegments.length > 0) {
        response.updateOutput(deltaSegments);
      }
    };

    try {
      for await (const rawChunk of iterable) {
        if (this._streamAborted) return;
        let chunk = toUint8(rawChunk);
        if (chunk.byteLength === 0) continue;

        if (channels === null) {
          if (headerCarry.byteLength > 0) {
            const combined = new Uint8Array(
              headerCarry.byteLength + chunk.byteLength,
            );
            combined.set(headerCarry, 0);
            combined.set(chunk, headerCarry.byteLength);
            chunk = combined;
            headerCarry = new Uint8Array(0);
          }
          if (chunk.byteLength < STREAM_HEADER_BYTES) {
            headerCarry = chunk;
            continue;
          }
          const view = new DataView(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          );
          channels = view.getUint32(CHANNELS_FIELD_OFFSET, true);
          if (channels === 0) {
            throw new QvacErrorAddonBCI({
              code: ERR_CODES.INVALID_STREAM_HEADER,
              adds: "channels is zero",
            });
          }
          bytesPerTimestep = channels * FLOAT32_BYTES;
          chunk = chunk.subarray(STREAM_HEADER_BYTES);
          if (chunk.byteLength === 0) continue;
        }

        body.push(chunk);
        bodyBytes += chunk.byteLength;

        while (
          !this._streamAborted &&
          Math.floor(bodyBytes / bytesPerTimestep) >=
            windowStartTs + opts.windowTimesteps
        ) {
          await decodeRange(windowStartTs, opts.windowTimesteps);
          if (this._streamAborted) return;
          windowStartTs += opts.hopTimesteps;
        }
      }

      if (this._streamAborted) return;

      if (channels === null && headerCarry.byteLength > 0) {
        throw new QvacErrorAddonBCI({
          code: ERR_CODES.INVALID_STREAM_HEADER,
          adds: `stream ended with ${headerCarry.byteLength} header byte(s) buffered; need ${STREAM_HEADER_BYTES}`,
        });
      }

      if (channels !== null) {
        const bufferedTs = Math.floor(bodyBytes / bytesPerTimestep);
        if (bufferedTs > lastDecodedEndTs && bufferedTs > windowStartTs) {
          await decodeRange(windowStartTs, bufferedTs - windowStartTs);
        }
      }

      if (!this._streamAborted) {
        this._streamResponse = null;
        if (opts.emit === "full") {
          response.ended(mergedText.length > 0 ? [{ text: mergedText }] : []);
        } else {
          response.ended();
        }
      }
    } catch (err) {
      this._streamResponse = null;
      throw err;
    }
  }

  private async _decodeWindow(
    windowBytes: Uint8Array,
  ): Promise<TranscriptSegment[]> {
    const addon = this.addon;
    if (!addon) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: "call load() before transcribeStream()",
      });
    }
    return new Promise<TranscriptSegment[]>((resolve, reject) => {
      const collected: TranscriptSegment[] = [];
      const cleanup = () => {
        this._streamWindowHandler = null;
        this._streamWindowReject = null;
      };
      this._streamWindowReject = (err: Error) => {
        cleanup();
        reject(err);
      };
      this._streamWindowHandler = (event, data, error) => {
        if (event === ADDON_EVENT.ERROR) {
          cleanup();
          const err =
            error instanceof Error
              ? error
              : new Error(
                  typeof error === "string" ? error : "window decode failed",
                );
          reject(err);
          return;
        }
        if (event === ADDON_EVENT.OUTPUT) {
          if (Array.isArray(data)) {
            for (const seg of data as { text?: unknown }[]) {
              if (seg && typeof seg.text === "string") {
                collected.push(seg as TranscriptSegment);
              }
            }
          } else if (
            data !== null &&
            typeof data === "object" &&
            typeof (data as { text?: unknown }).text === "string"
          ) {
            collected.push(data as TranscriptSegment);
          }
          return;
        }
        if (event === ADDON_EVENT.JOB_ENDED) {
          cleanup();
          resolve(collected);
        }
      };

      addon
        .runJob({ input: windowBytes })
        .then((accepted) => {
          if (!accepted) {
            cleanup();
            reject(
              new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING }),
            );
          }
        })
        .catch((err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(errorMessage(err)));
        });
    });
  }

  /**
   * Apply defaults and validate `streamOpts` passed to transcribeStream().
   * Centralised so the public method body stays focused on orchestration,
   * mirroring whispercpp's `_checkParamsExists` pattern. Returns a new
   * opts object; does not mutate the caller's input.
   */
  private _validateStreamOpts(streamOpts: StreamOpts): NormalizedStreamOpts {
    const windowTimesteps =
      streamOpts.windowTimesteps ?? DEFAULT_WINDOW_TIMESTEPS;
    const hopTimesteps = streamOpts.hopTimesteps ?? DEFAULT_HOP_TIMESTEPS;
    const emit: string = streamOpts.emit ?? "delta";

    if (!Number.isInteger(windowTimesteps) || windowTimesteps <= 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: "windowTimesteps must be a positive integer",
      });
    }
    if (!Number.isInteger(hopTimesteps) || hopTimesteps <= 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: "hopTimesteps must be a positive integer",
      });
    }
    if (hopTimesteps >= windowTimesteps) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: "hopTimesteps must be less than windowTimesteps",
      });
    }
    if (windowTimesteps > MAX_WINDOW_TIMESTEPS) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.WINDOW_TOO_LARGE,
        adds: String(MAX_WINDOW_TIMESTEPS),
      });
    }
    if (emit !== "delta" && emit !== "full") {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: `unsupported emit mode: ${emit}`,
      });
    }

    return {
      windowTimesteps,
      hopTimesteps,
      emit,
    };
  }

  private _normalizeNeuralStream(
    input: NeuralStreamInput,
  ): AsyncIterable<unknown> | Iterable<unknown> {
    if (input == null) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: "stream is required",
      });
    }
    if (
      typeof (input as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] === "function"
    ) {
      return input as AsyncIterable<unknown>;
    }
    if (input instanceof Uint8Array) return [input];
    if (Array.isArray(input)) return input;
    if (
      typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
    ) {
      return input as Iterable<unknown>;
    }
    throw new QvacErrorAddonBCI({
      code: ERR_CODES.INVALID_STREAM_INPUT,
      adds: "unsupported input type; expected async iterable, Uint8Array, or chunk array",
    });
  }

  /**
   * Serialize inference runs so a second transcribe() waits until the first
   * response settles. Separate from _withExclusiveRun (lifecycle ops) so
   * destroy/unload can still preempt.
   */
  private async _enqueueInference(
    runFn: () => Promise<QvacResponse>,
  ): Promise<QvacResponse> {
    const prev = this._inferenceQueueWaiter;
    let releaseSlot: () => void = () => {};
    this._inferenceQueueWaiter = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    await prev;
    let response: QvacResponse;
    try {
      response = await runFn();
    } catch (err) {
      releaseSlot();
      throw err;
    }
    void response
      .await()
      .finally(() => {
        releaseSlot();
      })
      .catch(() => {});
    return response;
  }

  private _assertReadyForInference(): BCIInterface {
    if (this.state.destroyed || !this.state.configLoaded || !this.addon) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: this.state.destroyed
          ? "instance was destroyed"
          : "call load() before transcribe()",
      });
    }
    return this.addon;
  }

  private _isConfigurationError(err: unknown): boolean {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ERR_ASSERTION"
    ) {
      return true;
    }
    if (err instanceof TypeError) return true;
    const msg = errorMessage(err);
    return (
      msg.includes("is required") ||
      msg.includes("is not a valid parameter") ||
      msg.includes("must be")
    );
  }

  /**
   * Single sink for native addon events. During a stream, events are
   * diverted to the active `_streamWindowHandler` (registered by
   * `_decodeWindow`) instead of the batch `_job`. This side-channel
   * exists because per-window `runJob` calls must resolve into the
   * streaming driver rather than the `_job` state machine, which is
   * reserved for batch `transcribe()` calls and not used while a stream
   * is active. When `_streamWindowHandler` is null the batch path runs.
   */
  private _outputCallback(
    _addon: unknown,
    event: string,
    jobId: number,
    data: unknown,
    error: unknown,
  ): void {
    if (this._streamWindowHandler) {
      this._streamWindowHandler(event, data, error);
      return;
    }
    if (event === ADDON_EVENT.ERROR) {
      this.logger.error(
        `Job ${jobId} failed with error: ${errorMessage(error)}`,
      );
      this._job.fail(error as Error);
      return;
    }
    if (event === ADDON_EVENT.OUTPUT) {
      this._job.output(data);
      return;
    }
    if (event === ADDON_EVENT.JOB_ENDED) {
      this.logger.info(`Job ${jobId} completed`);
      if (this.opts.stats) {
        this._job.end(data);
      } else {
        this._job.end();
      }
      return;
    }
    this.logger.debug(`Received event for job ${jobId}: ${event}`);
  }

  async cancel(): Promise<void> {
    this._teardownActiveStream("Stream cancelled");
    if (this.addon?.cancel) {
      await this.addon.cancel();
    }
    if (this._streamDriverPromise) {
      await this._streamDriverPromise;
    }
    if (this._job.active) {
      this._job.fail(new Error("Job cancelled"));
    }
  }

  async unload(): Promise<void> {
    return this._withExclusiveRun(async () => {
      this._teardownActiveStream("Model was unloaded");
      if (this._streamDriverPromise) {
        await this._streamDriverPromise;
      }
      await this._inferenceQueueWaiter;
      if (this.addon) {
        await this.addon.destroyInstance();
        this.addon = null;
      }
      if (this._job.active) {
        this._job.fail(new Error("Model was unloaded"));
      }
      this.state.configLoaded = false;
    });
  }

  async destroy(): Promise<void> {
    return this._withExclusiveRun(async () => {
      this._teardownActiveStream("Model was destroyed");
      if (this._streamDriverPromise) {
        await this._streamDriverPromise;
      }
      await this._inferenceQueueWaiter;
      if (this.addon) {
        await this.addon.destroyInstance();
        this.addon = null;
      }
      if (this._job.active) {
        this._job.fail(new Error("Model was destroyed"));
      }
      this.state.configLoaded = false;
      this.state.destroyed = true;
    });
  }
}

export { computeWER };

export default BCIWhispercpp;

const cjsExports = BCIWhispercpp as typeof BCIWhispercpp & {
  BCIWhispercpp?: typeof BCIWhispercpp;
  computeWER?: typeof computeWER;
};
cjsExports.BCIWhispercpp = BCIWhispercpp;
cjsExports.computeWER = computeWER;
module.exports = cjsExports;
