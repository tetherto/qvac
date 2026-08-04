"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
const QvacLogger = require("@qvac/logging");
// `./addon` and `./lib/error` are imported as whole-module aliases rather than
// named imports so the `VlaModel` namespace at the bottom of this file can
// re-export their members with `export import`. That is what makes the
// CommonJS "class object with attached properties" export shape part of the
// emitted declarations instead of an untyped `module.exports` cast.
const addonModule = require("./addon");
const errorModule = require("./lib/error");
/* eslint-enable @typescript-eslint/no-require-imports */
const infer_base_1 = require("@qvac/infer-base");
const { DEFAULT_IMAGE_SIZE } = addonModule;
const { QvacErrorAddonVla, ERR_CODES } = errorModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
const binding = require("./binding");
// Maps the C++ Priority enum (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) to the
// matching method on the JS QvacLogger instance. Mirrors diffusion-cpp.
const LOG_METHODS = ["error", "warn", "info", "debug"];
// Default verbosity sent to the C++ side when a logger is connected. Matches
// the JS-side QvacLogger default — INFO and above are forwarded, DEBUG drops
// unless explicitly raised.
const DEFAULT_NATIVE_VERBOSITY = 2; // INFO
function pickPrimaryGgufPath(files) {
    const FIRST_SHARD_REGEX = /-0*1-of-\d+\.gguf$/;
    return files.find((p) => FIRST_SHARD_REGEX.test(p)) || files[0];
}
// Largest camera count the native resolver accepts (GROOT_MAX_SANE_NUM_CAMERAS)
// — validated here too so a typo is a JS config error instead of a native throw.
const MAX_NUM_CAMERAS = 64;
// Largest embodiment id (GROOT_MAX_EMBODIMENT_CAT_ID). A cat_id indexes GR00T's
// CategorySpecificLinear bank, whose category dim the architecture fixes at 32,
// so 0..31 is the whole id space. Bounded here as well as natively because the
// binding would otherwise have to narrow a JS number to int32, and 2**32 narrows
// to 0 — silently selecting a different embodiment instead of failing.
const MAX_EMBODIMENT_CAT_ID = 31;
// Native error-message prefixes the wrapper classifies on. The C++ throw sites
// carry these verbatim and are marked with a comment naming this contract, so
// rewording one there is a visible break rather than a silent change of a
// public error code.
const NATIVE_ERR_MARKERS = Object.freeze({
    // Embodiment resolution — runs before any weight I/O, so every rejection is
    // about the request, not the file.
    resolve: "grootResolveEmbodiment:",
    // An embodiment named on an architecture that has none — also a request
    // error, but raised by the factory before any model exists to resolve on.
    archMismatch: "config.embodiment is GR00T-only",
    // setEmbodiment refused because an inference job is dispatched but unawaited.
    inFlight: "an inference job is in flight",
});
// Map a native throw out of the embodiment paths onto a public error code.
// Only the resolver's rejections are configuration errors; a switch can also
// fail because the GGUF moved, a read came up short, or an allocation failed,
// and reporting those as INVALID_CONFIG points the caller at the wrong problem
// (and invites an SDK to retry a "bad config" forever). Those are the same
// weight-read failures the load path reports, so they get the same code.
function classifyEmbodimentError(err) {
    const message = typeof err.message === "string" ? err.message : "";
    if (message.includes(NATIVE_ERR_MARKERS.inFlight)) {
        return ERR_CODES.JOB_ALREADY_RUNNING;
    }
    if (message.includes(NATIVE_ERR_MARKERS.resolve) ||
        message.includes(NATIVE_ERR_MARKERS.archMismatch)) {
        return ERR_CODES.INVALID_CONFIG;
    }
    return ERR_CODES.FAILED_TO_LOAD_WEIGHTS;
}
// Normalize the three accepted spellings of an embodiment selection into
// { tag, catId, numCameras }: a tag string, a numeric cat_id, or an object
// carrying either plus an optional camera-count override. `requireSelection`
// is set for setEmbodiment (a switch must name an embodiment) and clear for the
// load path (nothing named = the GGUF's default embodiment).
//
// A tag and a catId are two spellings of one selection, so passing both is an
// error rather than a precedence rule — the native resolver rejects it too.
function normalizeEmbodiment(value, requireSelection) {
    const bad = (adds) => new QvacErrorAddonVla({ code: ERR_CODES.INVALID_CONFIG, adds });
    const out = { tag: "", catId: -1, numCameras: 0 };
    // Unpack the accepted spellings into one { selector, numCameras } shape.
    let selector;
    let numCameras;
    if (value === undefined || value === null) {
        if (requireSelection) {
            throw bad("embodiment must be a tag string, a cat_id number, or an object");
        }
        return out;
    }
    else if (typeof value === "string" || typeof value === "number") {
        selector = value;
    }
    else if (typeof value === "object") {
        if (value.tag !== undefined && value.catId !== undefined) {
            throw bad("embodiment accepts either tag or catId, not both");
        }
        selector = value.tag !== undefined ? value.tag : value.catId;
        numCameras = value.numCameras;
    }
    else {
        throw bad("embodiment must be a string, number, or object");
    }
    if (typeof selector === "string") {
        if (selector.length === 0) {
            throw bad("embodiment tag must be a non-empty string");
        }
        out.tag = selector;
    }
    else if (typeof selector === "number") {
        if (!Number.isInteger(selector) ||
            selector < 0 ||
            selector > MAX_EMBODIMENT_CAT_ID) {
            throw bad(`embodiment catId must be an integer in 0..${MAX_EMBODIMENT_CAT_ID}`);
        }
        out.catId = selector;
    }
    else if (requireSelection) {
        throw bad("embodiment must name a tag or a catId");
    }
    if (numCameras !== undefined && numCameras !== null) {
        if (!Number.isInteger(numCameras) ||
            numCameras < 1 ||
            numCameras > MAX_NUM_CAMERAS) {
            throw bad(`embodiment numCameras must be an integer in 1..${MAX_NUM_CAMERAS}`);
        }
        out.numCameras = numCameras;
    }
    return out;
}
function validateRunInput(input, hparams) {
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
    const imagesArePatches = hparams != null && hparams.imageInputMode === "patches";
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
        }
        else if (img.length !== expectedPerImage) {
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
    if (input.noise !== undefined &&
        input.noise !== null &&
        !(input.noise instanceof Float32Array)) {
        throw new QvacErrorAddonVla({
            code: ERR_CODES.INVALID_INPUT,
            adds: "input.noise must be a Float32Array when provided",
        });
    }
    if (hparams &&
        hparams.stateInputMode === "continuous" &&
        Number.isInteger(hparams.maxStateDim)) {
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
        if (Number.isInteger(hparams.numCameras) &&
            input.images.length !== hparams.numCameras) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: `groot requires exactly ${hparams.numCameras} patch image buffers (got ${input.images.length})`,
            });
        }
        if (Number.isInteger(hparams.maxStateDim) &&
            input.state.length !== hparams.maxStateDim) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: `groot requires state.length === ${hparams.maxStateDim} (got ${input.state.length})`,
            });
        }
        if (!input.noise ||
            !(input.noise instanceof Float32Array) ||
            input.noise.length === 0) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: "groot requires input.noise (Float32Array) — flow matching needs a noise prior at t=1",
            });
        }
        // Exact length guards the native memcpy against an OOB read: GrootModel::infer
        // copies chunkSize*maxActionDim floats blindly from this buffer (no source-length
        // check), so a short array reads adjacent heap memory into the action prior.
        if (Number.isInteger(hparams.chunkSize) &&
            Number.isInteger(hparams.maxActionDim)) {
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
        if (Number.isInteger(hparams.numCameras) &&
            input.images.length !== hparams.numCameras) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: `pi05 requires exactly ${hparams.numCameras} camera images (got ${input.images.length})`,
            });
        }
        if (Number.isInteger(hparams.tokenizerMaxLength) &&
            input.tokens.length !== hparams.tokenizerMaxLength) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: `pi05 requires tokens.length === ${hparams.tokenizerMaxLength} (got ${input.tokens.length})`,
            });
        }
        if (!input.noise ||
            !(input.noise instanceof Float32Array) ||
            input.noise.length === 0) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_INPUT,
                adds: "pi05 requires input.noise (Float32Array) — flow matching needs a noise prior at t=1",
            });
        }
        // Same native-memcpy OOB guard as the groot branch: pi05 xT is action_horizon *
        // action_dim floats, surfaced as chunkSize * maxActionDim (max_action_dim maps
        // to action_dim for pi05), copied blindly from this buffer.
        if (Number.isInteger(hparams.chunkSize) &&
            Number.isInteger(hparams.maxActionDim)) {
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
class VlaModel {
    logger;
    opts;
    state;
    _files;
    _config;
    _job;
    _run;
    _handle;
    _hparams;
    _backendName;
    _hasActiveResponse;
    _nativeLoggerActive;
    _packageName;
    _packageVersion;
    // Per-run accumulator filled by _onAddonEvent; null between runs.
    _pending;
    constructor(options) {
        const { files, config = {}, logger = null, opts = {}, } = options ?? { files: { model: [] } };
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
        // `??` needed: the destructuring default only covers `undefined`, not `config: null`.
        this._config = config ?? {};
        this.logger = new QvacLogger(logger);
        this.opts = opts;
        // The cancel hook is wired to the framework's binding.cancel(handle)
        // through the public cancel() method; the createJobHandler tear-down
        // flows through that path.
        this._job = (0, infer_base_1.createJobHandler)({ cancel: () => this.cancel() });
        this._run = (0, infer_base_1.exclusiveRunQueue)();
        this._handle = null;
        this._hparams = null;
        this._backendName = null;
        this._hasActiveResponse = false;
        this._nativeLoggerActive = false;
        this._packageName = "@qvac/vla-ggml";
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is read from the package root at runtime.
        this._packageVersion = require("./package.json")
            .version;
        // Per-run accumulator filled by _onAddonEvent; null between runs.
        this._pending = null;
        this.state = { configLoaded: false, weightsLoaded: false };
    }
    _connectNativeLogger() {
        if (this._nativeLoggerActive)
            return;
        try {
            binding.setLogger((priority, message) => {
                const method = LOG_METHODS[priority] || "info";
                if (typeof this.logger[method] === "function") {
                    this.logger[method](`[C++] ${message}`);
                }
            });
            const verbosity = Number.isInteger(this._config.verbosity)
                ? this._config.verbosity
                : DEFAULT_NATIVE_VERBOSITY;
            try {
                binding.setVerbosity(verbosity);
            }
            catch { }
            this._nativeLoggerActive = true;
        }
        catch (err) {
            this.logger.warn("Failed to connect native logger:", err && err.message);
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
    _onAddonEvent(_jsHandle, eventTypeName, outputData, errorData) {
        // `_hasActiveResponse` is cleared by the response promise's .finally() in
        // _runInternal, NOT here — see the rationale block there. Doing it from
        // this callback would mean the flag stays set forever if the worker
        // aborts before delivering JobEnded/Error.
        if (typeof eventTypeName === "string" && eventTypeName.includes("Error")) {
            const err = new QvacErrorAddonVla({
                code: ERR_CODES.INFERENCE_FAILED,
                adds: typeof errorData === "string" ? errorData : "native error",
            });
            if (this._pending)
                this._pending.actions = null;
            this._pending = null;
            if (this._job.active)
                this._job.fail(err);
            return;
        }
        if (outputData instanceof Float32Array) {
            if (this._pending)
                this._pending.actions = outputData;
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
    _releaseNativeLogger() {
        if (!this._nativeLoggerActive)
            return;
        try {
            binding.releaseLogger();
        }
        catch { }
        this._nativeLoggerActive = false;
    }
    async load({ backend = "auto" } = {}) {
        if (backend !== "auto" && backend !== "cpu") {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INVALID_CONFIG,
                adds: `backend must be 'auto' or 'cpu' (got: ${String(backend)})`,
            });
        }
        return this._run(async () => {
            if (this.state.configLoaded)
                return;
            await this._load(backend);
            this.state.configLoaded = true;
            this.state.weightsLoaded = true;
        });
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async to preserve the Promise-returning contract; the load steps are synchronous native binding calls.
    async _load(backend) {
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
        // Validated before createInstance so a malformed selector is a JS config
        // error rather than a native throw. Nothing named = the GGUF's own default
        // embodiment, which is also a no-op on single-embodiment / non-GR00T GGUFs.
        const embodimentSel = normalizeEmbodiment(this._config.embodiment, false);
        try {
            // Canonical instance lifecycle (mirrors LLM/embed/NMT):
            // createInstance(jsHandle, params, outputCb) — the framework's
            // JobRunner thread consumes runJob() and feeds the outputCb.
            const backendsDir = this._config.backendsDir
                ? this._config.backendsDir
                : path.join(__dirname, "prebuilds");
            this._handle = binding.createInstance(this, {
                ggufPath,
                backend,
                backendsDir,
                embodiment: embodimentSel.tag,
                embodimentCatId: embodimentSel.catId >= 0 ? String(embodimentSel.catId) : "",
                embodimentNumCameras: embodimentSel.numCameras > 0
                    ? String(embodimentSel.numCameras)
                    : "",
            }, (jsHandle, eventTypeName, outputData, errorData) => {
                this._onAddonEvent(jsHandle, eventTypeName, outputData, errorData);
            });
            // No-op for VLA (no IModelAsyncLoad weights stream) but kept for
            // symmetry with sibling addons.
            binding.activate(this._handle);
            this._hparams = binding.getVlaHparams(this._handle);
            this._backendName = binding.getVlaBackendName(this._handle);
        }
        catch (loadError) {
            this.logger.error("Error during model load:", loadError);
            if (this._handle) {
                try {
                    binding.destroyInstance(this._handle);
                }
                catch { }
                this._handle = null;
            }
            // Same logger-leak guard as the missing-file path above.
            this._releaseNativeLogger();
            // An unresolvable embodiment is a bad config, not a bad weights file — it
            // is rejected before any weight I/O happens. Without this, the SAME root
            // cause reported INVALID_CONFIG through setEmbodiment() and
            // FAILED_TO_LOAD_WEIGHTS through the constructor. Everything else on this
            // path is already FAILED_TO_LOAD_WEIGHTS, which is what the shared
            // classifier falls back to.
            throw new QvacErrorAddonVla({
                code: classifyEmbodimentError(loadError),
                adds: loadError.message,
                cause: loadError,
            });
        }
        this.logger.info("Model load completed successfully");
    }
    get hparams() {
        return this._hparams;
    }
    get backendName() {
        return this._backendName;
    }
    // Switch a loaded multi-embodiment GR00T model to another embodiment shipped
    // in the same GGUF — no reload, only that embodiment's weight rows are re-read
    // (~20MB vs a multi-GB model load). Refreshes the cached hparams:
    // `numCameras` follows the new embodiment, so subsequent run() calls must pass
    // that many images.
    //
    // Takes a tag string, a numeric cat_id, or `{ tag | catId, numCameras }` —
    // `numCameras` overrides the GGUF's camera count for that embodiment, which is
    // how a row whose count was unknown at conversion time is run.
    //
    // Rejects (leaving the current embodiment active) for an unknown tag or
    // cat_id, one not stored in this GGUF, an embodiment with no known camera
    // count and no override, a single-embodiment model (including selecting the one
    // row a v1 GGUF bakes in), or an inference that has been dispatched and not
    // yet awaited.
    //
    // Unlike run(), this does NOT hand off to the worker thread: the row re-read
    // (~20MB) and the pre-transpose rebuild run synchronously, so on Bare's single
    // JS thread the call blocks other JS work for tens of ms — longer on mobile
    // flash under load. Accepted trade-off: switching is a control-plane operation
    // that must be ordered against in-flight inference anyway (hence the rejection
    // above), and routing it through the job queue would buy concurrency the
    // embodiment mutex would immediately serialize again. Switch between
    // inferences, not underneath one.
    async setEmbodiment(embodiment) {
        const sel = normalizeEmbodiment(embodiment, true);
        return this._run(() => this._setEmbodimentInternal(sel));
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async so setEmbodiment can serialize it through the exclusive run queue; the switch itself is a synchronous native call.
    async _setEmbodimentInternal(sel) {
        if (!this._handle) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.INSTANCE_NOT_INITIALIZED,
            });
        }
        // The _run queue is NOT sufficient on its own: run() releases it as soon as
        // it has dispatched the job and returned the QvacResponse, while the worker
        // thread reaches infer() later. Switching in that window would run inference
        // on the NEW weights against input already validated against the OLD
        // hparams — the native mutex serializes the two but cannot restore the
        // caller's intended order, so the result would be silently wrong for an
        // embodiment the caller never selected. Refuse until the response settles.
        if (this._hasActiveResponse) {
            throw new QvacErrorAddonVla({
                code: ERR_CODES.JOB_ALREADY_RUNNING,
                adds: "await the in-flight run() response before switching embodiment",
            });
        }
        try {
            this._hparams = binding.setVlaEmbodiment(this._handle, sel.catId >= 0 ? sel.catId : sel.tag, sel.numCameras);
        }
        catch (err) {
            // The binding enforces the same in-flight refusal natively. Pure wrapper
            // use cannot reach it — _hasActiveResponse is set synchronously after a
            // job is accepted and cleared only once the response settles, which is
            // strictly later than the native count clears in process(). It IS
            // reachable when a caller mixes the wrapper with binding.runJob directly,
            // which bumps the native count and no JS flag. Same cause as the check
            // above, so report the same code rather than blaming the config.
            throw new QvacErrorAddonVla({
                code: classifyEmbodimentError(err),
                adds: err.message,
                cause: err,
            });
        }
        return this._hparams;
    }
    async run(input) {
        return this._run(() => this._runInternal(input));
    }
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async so run() can serialize it through the exclusive run queue; dispatch is fire-and-forget.
    async _runInternal(input) {
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
        const response = this._job.start();
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
        }
        catch (err) {
            this._pending = null;
            this._job.fail(err);
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
        finalized.catch((err) => {
            this.logger?.warn?.("Inference response rejected:", err?.message || err);
        });
        // Make response.await() idempotent: subsequent calls return the same
        // chained promise so .finally() fires exactly once.
        response.await = () => finalized;
        this.logger.info("Inference job dispatched");
        return response;
    }
    async pause() {
        /* no-op: SmolVLA inference has no per-step cancel point */
    }
    async cancel() {
        if (this._handle) {
            try {
                await binding.cancel(this._handle);
            }
            catch { }
        }
    }
    async unload() {
        return this._run(async () => {
            await this.cancel();
            if (this._job.active) {
                this._job.fail(new QvacErrorAddonVla({ code: ERR_CODES.MODEL_UNLOADED }));
            }
            this._pending = null;
            this._hasActiveResponse = false;
            if (this._handle) {
                try {
                    binding.destroyInstance(this._handle);
                }
                catch (destroyError) {
                    this._handle = null;
                    this._releaseNativeLogger();
                    throw new QvacErrorAddonVla({
                        code: ERR_CODES.FAILED_TO_DESTROY,
                        adds: destroyError.message,
                        cause: destroyError,
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
    getState() {
        return this.state;
    }
}
// Alias used by the namespace below to re-export the class as a property of
// itself (`VlaModel.VlaModel`). `export import VlaModel = VlaModel` inside the
// namespace would resolve to the alias being declared, so the indirection is
// required.
var VlaModelClass = VlaModel;
/**
 * Declaration merging with the class above models this package's CommonJS
 * export shape — `module.exports` IS the `VlaModel` constructor, carrying the
 * named exports as own properties — directly in the type system. TypeScript
 * emits the property attachments natively, so the generated `index.js` and
 * `index.d.ts` can no longer drift from each other, and a CommonJS consumer
 * (`import VlaModel = require('@qvac/vla-ggml')`) gets a real construct
 * signature instead of TS2351.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace -- class/namespace merging is the only way to type a constructor-first CommonJS export (`module.exports = VlaModel` plus attached members).
(function (VlaModel) {
    VlaModel.VlaModel = VlaModelClass;
    VlaModel.preprocessImage = addonModule.preprocessImage;
    VlaModel.padState = addonModule.padState;
    VlaModel.DEFAULT_IMAGE_SIZE = addonModule.DEFAULT_IMAGE_SIZE;
    VlaModel.QvacErrorAddonVla = errorModule.QvacErrorAddonVla;
    VlaModel.ERR_CODES = errorModule.ERR_CODES;
})(VlaModel || (VlaModel = {}));
// Runtime-redundant, but required: cjs-module-lexer only detects top-level
// `module.exports.X =` assignments, so ESM named imports break without these.
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- `module.exports` is untyped CommonJS surface; these mirror the typed namespace members above. */
module.exports.VlaModel = VlaModel;
module.exports.preprocessImage = addonModule.preprocessImage;
module.exports.padState = addonModule.padState;
module.exports.DEFAULT_IMAGE_SIZE = addonModule.DEFAULT_IMAGE_SIZE;
module.exports.QvacErrorAddonVla = errorModule.QvacErrorAddonVla;
module.exports.ERR_CODES = errorModule.ERR_CODES;
module.exports = VlaModel;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */
