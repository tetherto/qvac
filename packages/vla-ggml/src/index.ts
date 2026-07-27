/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse as InferQvacResponse,
} from "@qvac/infer-base";
import {
  preprocessImage,
  padState,
  DEFAULT_IMAGE_SIZE,
} from "./addon";
import { QvacErrorAddonVla, ERR_CODES } from "./lib/error";

export { preprocessImage, padState, DEFAULT_IMAGE_SIZE };
export { QvacErrorAddonVla, ERR_CODES };

export interface VlaHparams {
  chunkSize: number;
  actionDim: number;
  maxActionDim: number;
  maxStateDim: number;
  tokenizerMaxLength: number;
  visionImageSize: number;
  /**
   * Number of camera views the model accepts. 2 for SmolVLA, up to 3 for
   * π₀.₅. Optional for back-compat — older addon builds may omit it.
   */
  numCameras?: number;
  /**
   * How the consumer passes the robot state. `'continuous'` (SmolVLA) means
   * the `state` Float32Array is projected by an in-model linear layer;
   * `'discrete'` (π₀.₅) means the state is already tokenized into the
   * language prompt and the `state` buffer is ignored. Optional for
   * back-compat.
   */
  stateInputMode?: "continuous" | "discrete";
  /**
   * How the consumer passes camera images. `'pixels'` (SmolVLA, π₀.₅) means
   * each image is a `3 · w · h` float pixel plane; `'patches'` (GR00T) means
   * each image is already patchified by Gr00tPolicy into a
   * `patches · patch_flat` buffer. Optional for back-compat.
   */
  imageInputMode?: "pixels" | "patches";
  /**
   * Exact per-image buffer length (in floats) required when
   * `imageInputMode === 'patches'`. Optional for back-compat.
   */
  imagePatchElems?: number;
}

export interface VlaRunInput {
  images: Float32Array[];
  imgWidth?: number;
  imgHeight?: number;
  state: Float32Array;
  tokens: Int32Array;
  mask: Uint8Array;
  noise?: Float32Array | null;
}

export interface VlaRunStats {
  vision_ms: number;
  /**
   * SmolVLA-specific legacy alias for `prefill_compute_ms`. Kept for
   * back-compat with consumers written against v0.1.x; will be removed once
   * π₀.₅ ships and consumers migrate to the architecture-neutral names.
   */
  smollm2_compute_ms: number;
  /** Legacy alias for `prefill_total_ms`; see `smollm2_compute_ms`. */
  smollm2_total_ms: number;
  /** Architecture-neutral prefill compute time (ms). */
  prefill_compute_ms: number;
  /** Architecture-neutral prefill total time (ms). */
  prefill_total_ms: number;
  ode_ms: number;
  total_ms: number;
  /** 0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL). */
  backendDevice: number;
}

export interface VlaRunResult {
  actions: Float32Array;
  stats: VlaRunStats;
}

export interface VlaModelOptions {
  files: { model: string[] };
  config?: VlaConfig;
  logger?: QvacLogger.LoggerInterface | null;
  opts?: { stats?: boolean };
}

export interface QvacResponse {
  await(): Promise<VlaRunResult>;
  cancel(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

interface VlaConfig {
  verbosity?: number;
  backendsDir?: string;
  [key: string]: unknown;
}

interface VlaInstanceConfig {
  ggufPath: string;
  backend: string;
  backendsDir: string;
}

type AddonOutputCallback = (
  jsHandle: unknown,
  eventTypeName: unknown,
  outputData: unknown,
  errorData: unknown,
) => void;

interface VlaJob {
  type: "vla";
  input: {
    images: Float32Array[];
    imgWidth: number;
    imgHeight: number;
    state: Float32Array;
    tokens: Int32Array;
    mask: Uint8Array;
    noise?: Float32Array;
  };
}

interface VlaBinding {
  setLogger(callback: (priority: number, message: string) => void): void;
  setVerbosity(verbosity: number): void;
  releaseLogger(): void;
  createInstance(
    owner: VlaModel,
    config: VlaInstanceConfig,
    outputCallback: AddonOutputCallback,
  ): object;
  activate(handle: object): void;
  getVlaHparams(handle: object): VlaHparams;
  getVlaBackendName(handle: object): string;
  runJob(handle: object, job: VlaJob): boolean;
  cancel(handle: object): Promise<void>;
  destroyInstance(handle: object): void;
}

interface VlaModelState {
  configLoaded: boolean;
  weightsLoaded: boolean;
}

type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
const binding = require("./binding") as VlaBinding;

// Maps the C++ Priority enum (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) to the
// matching method on the JS QvacLogger instance. Mirrors diffusion-cpp.
const LOG_METHODS = ["error", "warn", "info", "debug"] as const;

// Default verbosity sent to the C++ side when a logger is connected. Matches
// the JS-side QvacLogger default — INFO and above are forwarded, DEBUG drops
// unless explicitly raised.
const DEFAULT_NATIVE_VERBOSITY = 2; // INFO

function pickPrimaryGgufPath(files: string[]): string {
  const FIRST_SHARD_REGEX = /-0*1-of-\d+\.gguf$/;
  return files.find((p) => FIRST_SHARD_REGEX.test(p)) || files[0];
}

function validateRunInput(
  input: VlaRunInput,
  hparams: VlaHparams | null,
): { imgWidth: number; imgHeight: number } {
  if (!input || typeof input !== "object") {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input must be an object",
    });
  }
  if (!Array.isArray(input.images) || input.images.length === 0) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.images must be a non-empty array of Float32Array",
    });
  }
  const imgWidth = input.imgWidth ?? DEFAULT_IMAGE_SIZE;
  const imgHeight = input.imgHeight ?? DEFAULT_IMAGE_SIZE;
  // The C++ inference path requires img_width == img_height == hparams.visionImageSize
  // (SigLIP's conv2d output is sized from runtime args, but the downstream
  // patch-embedding reshape uses hp.vision_image_size — a mismatch trips
  // GGML_ASSERT in ggml.c, which is a hard abort that kills the worker).
  // Throw a clean QvacError here so the failure surfaces as a rejected
  // run() promise instead of a process crash.
  if (hparams && Number.isInteger(hparams.visionImageSize)) {
    const expected = hparams.visionImageSize;
    if (imgWidth !== expected || imgHeight !== expected) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `imgWidth/imgHeight (${imgWidth}x${imgHeight}) must equal hparams.visionImageSize (${expected})`,
      });
    }
  }
  // Pixel-plane models (smolvla, pi05) take `3 · w · h` floats per camera.
  // GR00T takes images already patchified by Gr00tPolicy — a
  // `patches · patch_flat` buffer whose exact length the native side copies
  // blindly (no source-length check before the memcpy), so it MUST be validated
  // here. The length is fixed per model (imgWidth is pinned to visionImageSize),
  // surfaced as `hparams.imagePatchElems`. `imageInputMode` is the
  // distinguishing axis (both groot and smolvla are `continuous` state).
  const imagesArePatches =
    hparams !== null && hparams.imageInputMode === "patches";
  const patchElems = imagesArePatches ? (hparams.imagePatchElems ?? 0) : 0;
  const patchElemsKnown = Number.isInteger(patchElems) && patchElems > 0;
  const expectedPerImage = 3 * imgWidth * imgHeight;
  for (let i = 0; i < input.images.length; i++) {
    const img = input.images[i];
    if (!(img instanceof Float32Array)) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `input.images[${i}] must be a Float32Array`,
      });
    }
    if (imagesArePatches) {
      // Exact length guards the native memcpy against an OOB read. The native
      // side copies patchElems floats per image blindly (no source-length
      // check), so the expected length MUST be known here; if the addon didn't
      // surface imagePatchElems (version skew), fail closed rather than pass an
      // unvalidated buffer to that memcpy.
      if (!patchElemsKnown) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_INPUT,
          adds: `input.images[${i}] (patches): addon did not surface hparams.imagePatchElems, cannot validate patch buffer length`,
        });
      }
      if (img.length !== patchElems) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_INPUT,
          adds: `input.images[${i}] (patches) length ${img.length} != ${patchElems}`,
        });
      }
    } else if (img.length !== expectedPerImage) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `input.images[${i}] length ${img.length} != 3*${imgWidth}*${imgHeight}`,
      });
    }
  }
  if (!(input.state instanceof Float32Array)) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.state must be a Float32Array",
    });
  }
  if (!(input.tokens instanceof Int32Array)) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.tokens must be an Int32Array",
    });
  }
  if (!(input.mask instanceof Uint8Array)) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.mask must be a Uint8Array",
    });
  }
  if (input.mask.length !== input.tokens.length) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.mask and input.tokens must have the same length",
    });
  }
  if (
    input.noise !== undefined &&
    input.noise !== null &&
    !(input.noise instanceof Float32Array)
  ) {
    throw new QvacErrorAddonVla({
      code: ERR_CODES.INVALID_INPUT,
      adds: "input.noise must be a Float32Array when provided",
    });
  }

  if (
    hparams &&
    hparams.stateInputMode === "continuous" &&
    Number.isInteger(hparams.maxStateDim)
  ) {
    if (input.state.length === 0 || input.state.length > hparams.maxStateDim) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `state.length (${input.state.length}) must be > 0 and <= hparams.maxStateDim (${hparams.maxStateDim})`,
      });
    }
  }

  // GR00T (imageInputMode 'patches') is a continuous-state flow-matching model
  // that does NOT sample noise internally — GrootModel::infer hard-rejects a
  // null noise. The discrete branch below already enforces this for pi05; do the
  // same for the continuous/patches path so a missing prior surfaces as a clean
  // INVALID_INPUT rather than an opaque INFERENCE_FAILED from the worker.
  if (hparams && hparams.imageInputMode === "patches") {
    // Fail closed on GR00T's fixed-shape embodiment contract before the noise
    // checks. GrootModel::infer derives the image-placeholder count from
    // nImages and accepts nImages >= 1, so a one-camera input against a
    // two-camera checkpoint would silently produce actions for the wrong camera
    // layout instead of a clean INVALID_INPUT. The shared continuous-state
    // check above allows state.length <= maxStateDim; GR00T needs it exact.
    if (
      Number.isInteger(hparams.numCameras) &&
      input.images.length !== hparams.numCameras
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `groot requires exactly ${hparams.numCameras} patch image buffers (got ${input.images.length})`,
      });
    }
    if (
      Number.isInteger(hparams.maxStateDim) &&
      input.state.length !== hparams.maxStateDim
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `groot requires state.length === ${hparams.maxStateDim} (got ${input.state.length})`,
      });
    }
    if (
      !input.noise ||
      !(input.noise instanceof Float32Array) ||
      input.noise.length === 0
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: "groot requires input.noise (Float32Array) — flow matching needs a noise prior at t=1",
      });
    }
    // Exact length guards the native memcpy against an OOB read: GrootModel::infer
    // copies chunkSize*maxActionDim floats blindly from this buffer (no source-length
    // check), so a short array reads adjacent heap memory into the action prior.
    if (
      Number.isInteger(hparams.chunkSize) &&
      Number.isInteger(hparams.maxActionDim)
    ) {
      const expectedNoise = hparams.chunkSize * hparams.maxActionDim;
      if (input.noise.length !== expectedNoise) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_INPUT,
          adds: `input.noise length ${input.noise.length} != ${expectedNoise} (chunkSize*maxActionDim)`,
        });
      }
    }
  }

  if (hparams && hparams.stateInputMode === "discrete") {
    if (
      Number.isInteger(hparams.numCameras) &&
      input.images.length !== hparams.numCameras
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `pi05 requires exactly ${hparams.numCameras} camera images (got ${input.images.length})`,
      });
    }
    if (
      Number.isInteger(hparams.tokenizerMaxLength) &&
      input.tokens.length !== hparams.tokenizerMaxLength
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: `pi05 requires tokens.length === ${hparams.tokenizerMaxLength} (got ${input.tokens.length})`,
      });
    }
    if (
      !input.noise ||
      !(input.noise instanceof Float32Array) ||
      input.noise.length === 0
    ) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_INPUT,
        adds: "pi05 requires input.noise (Float32Array) — flow matching needs a noise prior at t=1",
      });
    }
    // Same native-memcpy OOB guard as the groot branch: pi05 xT is action_horizon *
    // action_dim floats, surfaced as chunkSize * maxActionDim (max_action_dim maps
    // to action_dim for pi05), copied blindly from this buffer.
    if (
      Number.isInteger(hparams.chunkSize) &&
      Number.isInteger(hparams.maxActionDim)
    ) {
      const expectedNoise = hparams.chunkSize * hparams.maxActionDim;
      if (input.noise.length !== expectedNoise) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_INPUT,
          adds: `input.noise length ${input.noise.length} != ${expectedNoise} (chunkSize*maxActionDim)`,
        });
      }
    }
  }

  return { imgWidth, imgHeight };
}

export class VlaModel {
  readonly logger: QvacLogger;
  opts: { stats?: boolean };
  state: VlaModelState;

  private _files: string[];
  private _config: VlaConfig;
  private _job: JobHandler;
  private _run: RunExclusive;
  private _handle: object | null;
  private _hparams: VlaHparams | null;
  private _backendName: string | null;
  private _hasActiveResponse: boolean;
  private _nativeLoggerActive: boolean;
  private _packageName: string;
  private _packageVersion: string;
  // Per-run accumulator filled by _onAddonEvent; null between runs.
  private _pending: { actions: Float32Array | null } | null;

  constructor({
    files,
    config = {},
    logger = null,
    opts = {},
  }: VlaModelOptions = { files: { model: [] } }) {
    if (!files || !Array.isArray(files.model) || files.model.length === 0) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.MISSING_REQUIRED_PARAMETER,
        adds: "files.model (non-empty array of absolute paths)",
      });
    }
    for (const [i, entry] of files.model.entries()) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_CONFIG,
          adds: `files.model[${i}] must be an absolute path string`,
        });
      }
      if (!path.isAbsolute(entry)) {
        throw new QvacErrorAddonVla({
          code: ERR_CODES.INVALID_CONFIG,
          adds: `files.model[${i}] must be an absolute path (got: ${entry})`,
        });
      }
    }
    this._files = files.model;
    this._config = config;
    this.logger = new QvacLogger(logger as QvacLogger.LoggerInterface);
    this.opts = opts;
    // The cancel hook is wired to the framework's binding.cancel(handle)
    // through the public cancel() method; the createJobHandler tear-down
    // flows through that path.
    this._job = createJobHandler({ cancel: () => this.cancel() });
    this._run = exclusiveRunQueue() as RunExclusive;
    this._handle = null;
    this._hparams = null;
    this._backendName = null;
    this._hasActiveResponse = false;
    this._nativeLoggerActive = false;
    this._packageName = "@qvac/vla-ggml";
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
    this._packageVersion = (require("./package.json") as { version: string })
      .version;
    // Per-run accumulator filled by _onAddonEvent; null between runs.
    this._pending = null;
    this.state = { configLoaded: false, weightsLoaded: false };
  }

  private _connectNativeLogger(): void {
    if (this._nativeLoggerActive) return;
    try {
      binding.setLogger((priority: number, message: string) => {
        const method = LOG_METHODS[priority] || "info";
        if (typeof this.logger[method] === "function") {
          this.logger[method](`[C++] ${message}`);
        }
      });
      const verbosity = Number.isInteger(this._config.verbosity)
        ? (this._config.verbosity as number)
        : DEFAULT_NATIVE_VERBOSITY;
      try {
        binding.setVerbosity(verbosity);
      } catch {}
      this._nativeLoggerActive = true;
    } catch (err) {
      this.logger.warn(
        "Failed to connect native logger:",
        err && (err as Error).message,
      );
    }
  }

  // Framework output callback: invoked from the JS event loop after each
  // event the worker thread queues. The shape is:
  //   (jsHandle, eventTypeName, outputData, errorData)
  // For VLA we receive at most three event types per job:
  //   - Output (Float32Array)        — the action chunk.
  //   - JobEnded (RuntimeStats obj)  — finishing event with timing/stats.
  //   - Error (string in errorData)  — eventTypeName contains "Error".
  // The pair is accumulated in `_pending` and surfaced through the active
  // _job response (`_job.output` / `_job.end` / `_job.fail`) so the public
  // `model.run(input)` Promise resolves with `{ actions, stats }` once both
  // halves have arrived — preserving the previous external API even though
  // the underlying dispatch is now asynchronous.
  private _onAddonEvent(
    _jsHandle: unknown,
    eventTypeName: unknown,
    outputData: unknown,
    errorData: unknown,
  ): void {
    // `_hasActiveResponse` is cleared by the response promise's .finally() in
    // _runInternal, NOT here — see the rationale block there. Doing it from
    // this callback would mean the flag stays set forever if the worker
    // aborts before delivering JobEnded/Error.
    if (typeof eventTypeName === "string" && eventTypeName.includes("Error")) {
      const err = new QvacErrorAddonVla({
        code: ERR_CODES.INFERENCE_FAILED,
        adds: typeof errorData === "string" ? errorData : "native error",
      });
      if (this._pending) this._pending.actions = null;
      this._pending = null;
      if (this._job.active) this._job.fail(err);
      return;
    }
    if (outputData instanceof Float32Array) {
      if (this._pending) this._pending.actions = outputData;
      this._job.output(outputData);
      return;
    }
    if (outputData && typeof outputData === "object") {
      const stats = outputData;
      const actions = this._pending ? this._pending.actions : null;
      this._pending = null;
      this._job.end(this.opts.stats ? stats : null, { actions, stats });
    }
  }

  private _releaseNativeLogger(): void {
    if (!this._nativeLoggerActive) return;
    try {
      binding.releaseLogger();
    } catch {}
    this._nativeLoggerActive = false;
  }

  async load({ backend = "auto" }: { backend?: "auto" | "cpu" } = {}): Promise<void> {
    if (backend !== "auto" && backend !== "cpu") {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INVALID_CONFIG,
        adds: `backend must be 'auto' or 'cpu' (got: ${String(backend)})`,
      });
    }
    return this._run(async () => {
      if (this.state.configLoaded) return;
      await this._load(backend);
      this.state.configLoaded = true;
      this.state.weightsLoaded = true;
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve the Promise-returning contract; the load steps are synchronous native binding calls.
  private async _load(backend: string): Promise<void> {
    this.logger.info("Starting model load");
    this._connectNativeLogger();
    const ggufPath = pickPrimaryGgufPath(this._files);
    if (!fs.existsSync(ggufPath)) {
      // _connectNativeLogger has already registered a JS callback with
      // the native side; without unregistering, that callback pins the
      // Bare event loop and prevents the process from exiting. Release
      // before throwing so a `new VlaModel(...).load()` against a
      // non-existent file leaves no event-loop references behind.
      this._releaseNativeLogger();
      throw new QvacErrorAddonVla({
        code: ERR_CODES.MODEL_NOT_FOUND,
        adds: ggufPath,
      });
    }
    try {
      // Canonical instance lifecycle (mirrors LLM/embed/NMT):
      // createInstance(jsHandle, params, outputCb) — the framework's
      // JobRunner thread consumes runJob() and feeds the outputCb.
      const backendsDir = this._config.backendsDir
        ? this._config.backendsDir
        : path.join(__dirname, "prebuilds");
      this._handle = binding.createInstance(
        this,
        { ggufPath, backend, backendsDir },
        (jsHandle, eventTypeName, outputData, errorData) => {
          this._onAddonEvent(jsHandle, eventTypeName, outputData, errorData);
        },
      );
      // No-op for VLA (no IModelAsyncLoad weights stream) but kept for
      // symmetry with sibling addons.
      binding.activate(this._handle);
      this._hparams = binding.getVlaHparams(this._handle);
      this._backendName = binding.getVlaBackendName(this._handle);
    } catch (loadError) {
      this.logger.error("Error during model load:", loadError);
      if (this._handle) {
        try {
          binding.destroyInstance(this._handle);
        } catch {}
        this._handle = null;
      }
      // Same logger-leak guard as the missing-file path above.
      this._releaseNativeLogger();
      throw new QvacErrorAddonVla({
        code: ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: (loadError as Error).message,
        cause: loadError as Error,
      });
    }
    this.logger.info("Model load completed successfully");
  }

  get hparams(): VlaHparams | null {
    return this._hparams;
  }

  get backendName(): string | null {
    return this._backendName;
  }

  async run(input: VlaRunInput): Promise<QvacResponse> {
    return this._run(() => this._runInternal(input));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- kept async so run() can serialize it through the exclusive run queue; dispatch is fire-and-forget.
  private async _runInternal(input: VlaRunInput): Promise<QvacResponse> {
    if (!this._handle) {
      throw new QvacErrorAddonVla({
        code: ERR_CODES.INSTANCE_NOT_INITIALIZED,
      });
    }
    if (this._hasActiveResponse) {
      throw new QvacErrorAddonVla({ code: ERR_CODES.JOB_ALREADY_RUNNING });
    }

    const { imgWidth, imgHeight } = validateRunInput(input, this._hparams);

    this.logger.info("Starting inference");

    const response: InferQvacResponse = this._job.start();
    // Per-job accumulator. Two events flow through _onAddonEvent: the
    // Float32Array action chunk lands first, then the RuntimeStats object —
    // we resolve the response only when both have arrived.
    this._pending = { actions: null };

    let accepted = false;
    try {
      accepted = binding.runJob(this._handle, {
        type: "vla",
        input: {
          images: input.images,
          imgWidth,
          imgHeight,
          state: input.state,
          tokens: input.tokens,
          mask: input.mask,
          noise: input.noise ?? undefined,
        },
      });
    } catch (err) {
      this._pending = null;
      this._job.fail(err as Error);
      throw err;
    }

    if (!accepted) {
      this._pending = null;
      const err = new QvacErrorAddonVla({
        code: ERR_CODES.JOB_ALREADY_RUNNING,
      });
      this._job.fail(err);
      throw err;
    }

    // Only mark the model busy once the worker has actually accepted the job.
    // Clear via `.finally()` on the response promise, not from inside the
    // native event callback — if the worker thread aborts mid-inference
    // (e.g. an unrecoverable GGML_ASSERT in smolvla.cpp) no JobEnded/Error
    // event is delivered and the previous "clear from _onAddonEvent" pattern
    // would leave the flag set forever, wedging every subsequent run() with
    // JOB_ALREADY_RUNNING. Mirrors qvac-lib-infer-llamacpp-llm/index.js.
    this._hasActiveResponse = true;
    const finalized = response.await().finally(() => {
      this._hasActiveResponse = false;
    });
    // Swallow rejections at the unobserved-promise level so an awaiter who
    // catches still sees the rejection through their own await; without
    // this the runtime logs an "unhandled promise rejection" warning.
    finalized.catch((err: unknown) => {
      this.logger?.warn?.(
        "Inference response rejected:",
        (err as { message?: string } | undefined)?.message || err,
      );
    });
    // Make response.await() idempotent: subsequent calls return the same
    // chained promise so .finally() fires exactly once.
    response.await = () => finalized;

    this.logger.info("Inference job dispatched");
    return response;
  }

  async pause(): Promise<void> {
    /* no-op: SmolVLA inference has no per-step cancel point */
  }

  async cancel(): Promise<void> {
    if (this._handle) {
      try {
        await binding.cancel(this._handle);
      } catch {}
    }
  }

  async unload(): Promise<void> {
    return this._run(async () => {
      await this.cancel();
      if (this._job.active) {
        this._job.fail(
          new QvacErrorAddonVla({ code: ERR_CODES.MODEL_UNLOADED }),
        );
      }
      this._pending = null;
      this._hasActiveResponse = false;
      if (this._handle) {
        try {
          binding.destroyInstance(this._handle);
        } catch (destroyError) {
          this._handle = null;
          this._releaseNativeLogger();
          throw new QvacErrorAddonVla({
            code: ERR_CODES.FAILED_TO_DESTROY,
            adds: (destroyError as Error).message,
            cause: destroyError as Error,
          });
        }
        this._handle = null;
      }
      this._releaseNativeLogger();
      this._hparams = null;
      this._backendName = null;
      this.state.configLoaded = false;
      this.state.weightsLoaded = false;
    });
  }

  getState(): VlaModelState {
    return this.state;
  }
}

export default VlaModel;

const cjsExports = VlaModel as typeof VlaModel & {
  VlaModel?: typeof VlaModel;
  preprocessImage?: typeof preprocessImage;
  padState?: typeof padState;
  DEFAULT_IMAGE_SIZE?: typeof DEFAULT_IMAGE_SIZE;
  QvacErrorAddonVla?: typeof QvacErrorAddonVla;
  ERR_CODES?: typeof ERR_CODES;
};
cjsExports.VlaModel = VlaModel;
cjsExports.preprocessImage = preprocessImage;
cjsExports.padState = padState;
cjsExports.DEFAULT_IMAGE_SIZE = DEFAULT_IMAGE_SIZE;
cjsExports.QvacErrorAddonVla = QvacErrorAddonVla;
cjsExports.ERR_CODES = ERR_CODES;
module.exports = cjsExports;
