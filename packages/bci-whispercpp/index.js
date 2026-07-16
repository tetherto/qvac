'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const { createJobHandler, exclusiveRunQueue, QvacResponse } = require('@qvac/infer-base')

const { BCIInterface } = require('./bci')
const { QvacErrorAddonBCI, ERR_CODES } = require('./lib/error')
const { computeWER } = require('./lib/wer')
const { toUint8, sliceBody, buildWindowBuffer, stitchSegments } = require('./lib/stream')
const {
  STREAM_HEADER_BYTES,
  CHANNELS_FIELD_OFFSET,
  FLOAT32_BYTES,
  ADDON_EVENT
} = require('./lib/constants')

// Consumed by the native addon on Android only (no-op elsewhere), where it is
// joined with the compile-time BACKENDS_SUBDIR before ggml loads the per-arch
// backend `.so` files.
const PREBUILDS_DIR = path.join(__dirname, 'prebuilds')

// MAX_WINDOW_TIMESTEPS stays below the whisper encoder's ~3000-timestep
// per-forward ceiling so even a final partial-window flush fits without
// native-side truncation; larger requests surface as WINDOW_TOO_LARGE.
// The 1500/500 default window/hop is a balanced first step: it decodes
// quickly while the ~33% overlap lets the word-stitcher deduplicate across
// boundaries without decoding the same signal twice.
// MAX_STITCH_WORDS bounds the suffix/prefix search so the merge stays
// O(maxWords^2) regardless of transcript length.
const DEFAULT_WINDOW_TIMESTEPS = 1500
const DEFAULT_HOP_TIMESTEPS = 500
const MAX_WINDOW_TIMESTEPS = 2900
const MAX_STITCH_WORDS = 40

function collectSegments(collected, data) {
  if (Array.isArray(data)) {
    for (const seg of data) {
      if (seg && typeof seg.text === 'string') collected.push(seg)
    }
  } else if (data && typeof data.text === 'string') {
    collected.push(data)
  }
}

/**
 * BCI neural signal transcription client powered by whisper.cpp.
 *
 * Follows the same architecture as TranscriptionWhispercpp / LlmLlamacpp:
 * standalone class using createJobHandler + exclusiveRunQueue from
 * @qvac/infer-base.
 */
class BCIWhispercpp {
  /**
   * @param {Object} args
   * @param {Object} args.files - local model file paths
   * @param {string} args.files.model - path to the BCI GGML model file
   * @param {string} [args.files.embedder] - optional path to the embedder
   *   weights file. When omitted, the native addon falls back to resolving
   *   `bci-embedder.bin` next to `files.model`.
   * @param {Object} [args.logger] - optional logger instance
   * @param {Object} [args.opts] - optional options (e.g. { stats: true })
   * @param {Object} config - inference configuration
   * @param {Object} config.whisperConfig - whisper decoding params
   * @param {Object} [config.bciConfig] - BCI-specific params (e.g. { day_idx: 1 })
   * @param {Object} [config.contextParams] - whisper context params
   * @param {Object} [config.miscConfig] - miscellaneous config
   */
  constructor({ files, logger = null, opts = {} }, config = {}) {
    if (!files || typeof files.model !== 'string' || files.model.length === 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: 'files.model is required'
      })
    }

    if (
      files.embedder !== undefined &&
      (typeof files.embedder !== 'string' || files.embedder.length === 0)
    ) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: 'files.embedder must be a non-empty string when provided'
      })
    }

    this._files = { model: files.model }
    if (typeof files.embedder === 'string' && files.embedder.length > 0) {
      this._files.embedder = files.embedder
    }
    this._config = config
    this.opts = opts
    this.logger = new QvacLogger(logger)
    this._withExclusiveRun = exclusiveRunQueue()
    this._inferenceQueueWaiter = Promise.resolve()
    this._job = createJobHandler({
      cancel: () => this.addon?.cancel()
    })

    this.addon = null
    this.state = {
      configLoaded: false,
      destroyed: false
    }

    // Stream lifecycle state. A stream is considered active iff
    // `_streamResponse` is non-null; no separate boolean is needed. The
    // handler/reject pair is the side-channel `_outputCallback` uses to
    // divert per-window events to `_decodeWindow` while a stream is running.
    this._streamResponse = null
    this._streamWindowHandler = null
    this._streamWindowReject = null
    this._streamDriverPromise = null
    this._streamAborted = false
  }

  /**
   * Abort any active stream: reject the in-flight window decode (if any),
   * clear the stream side-channel, and fail the outward-facing response.
   * Idempotent. Does NOT await the driver - callers that need the driver
   * to fully unwind (unload/destroy) should `await this._streamDriverPromise`
   * after calling this.
   */
  _teardownActiveStream(reason) {
    this._streamAborted = true
    this._streamWindowHandler = null
    if (this._streamWindowReject) {
      const rej = this._streamWindowReject
      this._streamWindowReject = null
      rej(new Error(reason))
    }
    if (this._streamResponse) {
      const r = this._streamResponse
      this._streamResponse = null
      r.failed(new Error(reason))
    }
  }

  getState() {
    return this.state
  }

  async load() {
    if (this.state.destroyed) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: 'instance was destroyed'
      })
    }
    if (this.state.configLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
  }

  async _load() {
    if (!fs.existsSync(this._files.model)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: this._files.model
      })
    }

    if (this._files.embedder && !fs.existsSync(this._files.embedder)) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_FILE_NOT_FOUND,
        adds: this._files.embedder
      })
    }

    const whisperConfig = {
      language: 'en',
      n_threads: 0,
      ...(this._config.whisperConfig || {})
    }

    const configurationParams = {
      contextParams: {
        model: this._files.model,
        ...(this._config.contextParams || {})
      },
      whisperConfig,
      miscConfig: {
        caption_enabled: false,
        ...(this._config.miscConfig || {})
      },
      // Override-only key. Native side falls back to `ggml_backend_load_all()`
      // (default search path) on Android when this is empty -- which fails
      // inside an APK with the standard packaging options that compress
      // native libs. Defaulting to the in-package prebuilds dir keeps
      // mobile builds working out of the box, parity with transcription-
      // whispercpp 0.9.0.
      backendsDir:
        typeof this._config.backendsDir === 'string' && this._config.backendsDir.length > 0
          ? this._config.backendsDir
          : PREBUILDS_DIR
    }

    if (this._config.bciConfig) {
      configurationParams.bciConfig = this._config.bciConfig
    }

    // Optional override. When provided, the native side loads the embedder
    // weights from this exact path instead of resolving `bci-embedder.bin`
    // next to the GGML model file. Mirrors the `backendsDir` override.
    if (this._files.embedder) {
      configurationParams.embedderPath = this._files.embedder
    }

    if (this.state.destroyed) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: 'instance was destroyed'
      })
    }

    const binding = require('./binding')
    try {
      this.addon = new BCIInterface(
        binding,
        configurationParams,
        this._outputCallback.bind(this),
        this.logger.info.bind(this.logger)
      )
    } catch (err) {
      this.addon = null
      const configError = this._isConfigurationError(err)
      throw new QvacErrorAddonBCI({
        code: configError ? ERR_CODES.INVALID_CONFIG : ERR_CODES.FAILED_TO_LOAD_WEIGHTS,
        adds: err.message,
        cause: err
      })
    }

    try {
      await this.addon.activate()
    } catch (err) {
      this.addon = null
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: err.message,
        cause: err
      })
    }
    this.logger.info('BCI addon activated')
  }

  /**
   * Transcribe a neural signal from a binary file.
   * Convenience wrapper around transcribe().
   * @param {string} filePath - path to .bin neural signal file
   * @returns {Promise<QvacResponse>}
   */
  async transcribeFile(filePath) {
    const data = fs.readFileSync(filePath)
    return this.transcribe(new Uint8Array(data))
  }

  /**
   * Transcribe neural signal data (batch mode).
   * Returns a QvacResponse; use response.await() for the final output array,
   * response.onUpdate() for streaming updates, response.stats for runtime stats.
   * @param {Uint8Array} neuralData - binary neural signal
   * @returns {Promise<QvacResponse>}
   */
  async transcribe(neuralData) {
    this._assertReadyForInference()
    return await this._enqueueInference(async () => {
      const response = this._job.start()

      let accepted
      try {
        accepted = await this.addon.runJob({ input: neuralData })
      } catch (err) {
        this._job.fail(err)
        throw err
      }
      if (!accepted) {
        const error = new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING })
        this._job.fail(error)
        throw error
      }

      const finalized = response.await()
      finalized.catch(() => {})
      response.await = () => finalized
      return response
    })
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
   *
   * @param {AsyncIterable|Iterable|Uint8Array|Uint8Array[]} neuralStream
   * @param {Object} [streamOpts]
   * @param {number} [streamOpts.windowTimesteps=1500] - decode window size
   *   in timesteps. Must be > 0 and ≤ MAX_WINDOW_TIMESTEPS.
   * @param {number} [streamOpts.hopTimesteps=500] - how far the window
   *   advances between decodes. Must be > 0 and < windowTimesteps.
   * @param {'delta'|'full'} [streamOpts.emit='delta'] - whether each
   *   update carries only the newly-discovered tail ('delta') or the
   *   full running transcript ('full').
   * @returns {Promise<QvacResponse>}
   */
  async transcribeStream(neuralStream, streamOpts = {}) {
    this._assertReadyForInference()
    if (this._streamResponse !== null) {
      throw new QvacErrorAddonBCI({ code: ERR_CODES.STREAM_ALREADY_ACTIVE })
    }

    const opts = this._validateStreamOpts(streamOpts)
    const iterable = this._normalizeNeuralStream(neuralStream)

    return await this._enqueueInference(async () => {
      this._streamAborted = false
      const response = new QvacResponse({
        cancelHandler: async () => {
          await this.cancel()
        }
      })
      this._streamResponse = response

      const driver = this._runStreamDriver(iterable, opts, response)
        .catch((err) => {
          if (this._streamResponse === response) {
            this._streamResponse = null
          }
          response.failed(err)
        })
        .finally(() => {
          if (this._streamDriverPromise === driver) {
            this._streamDriverPromise = null
          }
        })
      this._streamDriverPromise = driver

      return response
    })
  }

  async _runStreamDriver(iterable, opts, response) {
    const ctx = {
      opts,
      response,
      channels: null,
      headerCarry: new Uint8Array(0),
      body: [],
      bodyBytes: 0,
      bytesPerTimestep: 0,
      windowStartTs: 0,
      lastDecodedEndTs: 0,
      mergedText: ''
    }

    try {
      await this._consumeStream(iterable, ctx)
      if (this._streamAborted) return
      this._assertHeaderComplete(ctx)
      await this._flushFinalWindow(ctx)
      this._finalizeStream(ctx)
    } catch (err) {
      this._streamResponse = null
      throw err
    }
  }

  async _consumeStream(iterable, ctx) {
    for await (const rawChunk of iterable) {
      if (this._streamAborted) return
      const chunk = toUint8(rawChunk)
      if (chunk.byteLength === 0) continue
      await this._ingestChunk(chunk, ctx)
      if (this._streamAborted) return
    }
  }

  async _ingestChunk(chunk, ctx) {
    let body = chunk
    if (ctx.channels === null) {
      body = this._consumeHeader(chunk, ctx)
      if (body === null || body.byteLength === 0) return
    }
    ctx.body.push(body)
    ctx.bodyBytes += body.byteLength
    await this._emitReadyWindows(ctx)
  }

  // Parse the [T, C] header once, buffering across chunks until the full
  // header has arrived. Returns the post-header body bytes, or null while
  // still waiting for more header bytes.
  _consumeHeader(chunk, ctx) {
    if (ctx.headerCarry.byteLength > 0) {
      const combined = new Uint8Array(ctx.headerCarry.byteLength + chunk.byteLength)
      combined.set(ctx.headerCarry, 0)
      combined.set(chunk, ctx.headerCarry.byteLength)
      chunk = combined
      ctx.headerCarry = new Uint8Array(0)
    }
    if (chunk.byteLength < STREAM_HEADER_BYTES) {
      ctx.headerCarry = chunk
      return null
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const channels = view.getUint32(CHANNELS_FIELD_OFFSET, true)
    if (channels === 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_HEADER,
        adds: 'channels is zero'
      })
    }
    ctx.channels = channels
    ctx.bytesPerTimestep = channels * FLOAT32_BYTES
    return chunk.subarray(STREAM_HEADER_BYTES)
  }

  async _emitReadyWindows(ctx) {
    while (
      !this._streamAborted &&
      Math.floor(ctx.bodyBytes / ctx.bytesPerTimestep) >=
        ctx.windowStartTs + ctx.opts.windowTimesteps
    ) {
      await this._decodeRange(ctx, ctx.windowStartTs, ctx.opts.windowTimesteps)
      if (this._streamAborted) return
      ctx.windowStartTs += ctx.opts.hopTimesteps
    }
  }

  async _decodeRange(ctx, startTs, windowTs) {
    if (this._streamAborted) return
    if (windowTs <= 0) return
    const endTs = startTs + windowTs
    if (endTs <= ctx.lastDecodedEndTs) return

    const windowBody = sliceBody(ctx.body, ctx.bytesPerTimestep, startTs, endTs, ctx.bodyBytes)
    const windowBuf = buildWindowBuffer(windowBody, ctx.channels, windowTs)

    this.logger.debug('Decoding stream window', {
      startTimestep: startTs,
      endTimestep: endTs,
      windowTimesteps: windowTs
    })

    const segments = await this._decodeWindow(windowBuf)
    ctx.lastDecodedEndTs = endTs

    const { deltaSegments, merged } = stitchSegments(
      ctx.mergedText,
      segments,
      MAX_STITCH_WORDS,
      startTs
    )
    ctx.mergedText = merged
    this._emitWindowUpdate(ctx, merged, deltaSegments)
  }

  _emitWindowUpdate(ctx, merged, deltaSegments) {
    if (ctx.opts.emit === 'full') {
      if (merged.length > 0) {
        ctx.response.updateOutput([{ text: merged }])
      }
    } else if (deltaSegments.length > 0) {
      ctx.response.updateOutput(deltaSegments)
    }
  }

  _assertHeaderComplete(ctx) {
    if (ctx.channels === null && ctx.headerCarry.byteLength > 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_HEADER,
        adds: `stream ended with ${ctx.headerCarry.byteLength} header byte(s) buffered; need ${STREAM_HEADER_BYTES}`
      })
    }
  }

  async _flushFinalWindow(ctx) {
    if (ctx.channels === null) return
    const bufferedTs = Math.floor(ctx.bodyBytes / ctx.bytesPerTimestep)
    if (bufferedTs > ctx.lastDecodedEndTs && bufferedTs > ctx.windowStartTs) {
      await this._decodeRange(ctx, ctx.windowStartTs, bufferedTs - ctx.windowStartTs)
    }
  }

  _finalizeStream(ctx) {
    if (this._streamAborted) return
    this._streamResponse = null
    if (ctx.opts.emit === 'full') {
      ctx.response.ended(ctx.mergedText.length > 0 ? [{ text: ctx.mergedText }] : [])
    } else {
      ctx.response.ended()
    }
  }

  async _decodeWindow(windowBytes) {
    return await new Promise((resolve, reject) => {
      const collected = []
      const cleanup = () => {
        this._streamWindowHandler = null
        this._streamWindowReject = null
      }
      this._streamWindowReject = (err) => {
        cleanup()
        reject(err)
      }
      this._streamWindowHandler = (event, data, error) => {
        if (event === ADDON_EVENT.ERROR) {
          cleanup()
          const err =
            error instanceof Error
              ? error
              : new Error(typeof error === 'string' ? error : 'window decode failed')
          reject(err)
          return
        }
        if (event === ADDON_EVENT.OUTPUT) {
          collectSegments(collected, data)
          return
        }
        if (event === ADDON_EVENT.JOB_ENDED) {
          cleanup()
          resolve(collected)
        }
      }

      this.addon
        .runJob({ input: windowBytes })
        .then((accepted) => {
          if (!accepted) {
            cleanup()
            reject(new QvacErrorAddonBCI({ code: ERR_CODES.JOB_ALREADY_RUNNING }))
          }
        })
        .catch((err) => {
          cleanup()
          reject(err)
        })
    })
  }

  /**
   * Apply defaults and validate `streamOpts` passed to transcribeStream().
   * Centralised so the public method body stays focused on orchestration,
   * mirroring whispercpp's `_checkParamsExists` pattern. Returns a new
   * opts object; does not mutate the caller's input.
   */
  _validateStreamOpts(streamOpts) {
    const opts = {
      windowTimesteps: streamOpts.windowTimesteps ?? DEFAULT_WINDOW_TIMESTEPS,
      hopTimesteps: streamOpts.hopTimesteps ?? DEFAULT_HOP_TIMESTEPS,
      emit: streamOpts.emit ?? 'delta'
    }

    if (!Number.isInteger(opts.windowTimesteps) || opts.windowTimesteps <= 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: 'windowTimesteps must be a positive integer'
      })
    }
    if (!Number.isInteger(opts.hopTimesteps) || opts.hopTimesteps <= 0) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: 'hopTimesteps must be a positive integer'
      })
    }
    if (opts.hopTimesteps >= opts.windowTimesteps) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: 'hopTimesteps must be less than windowTimesteps'
      })
    }
    if (opts.windowTimesteps > MAX_WINDOW_TIMESTEPS) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.WINDOW_TOO_LARGE,
        adds: MAX_WINDOW_TIMESTEPS
      })
    }
    if (opts.emit !== 'delta' && opts.emit !== 'full') {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: `unsupported emit mode: ${opts.emit}`
      })
    }

    return opts
  }

  _normalizeNeuralStream(input) {
    if (input == null) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.INVALID_STREAM_INPUT,
        adds: 'stream is required'
      })
    }
    if (typeof input[Symbol.asyncIterator] === 'function') return input
    if (input instanceof Uint8Array) return [input]
    if (Array.isArray(input)) return input
    if (typeof input[Symbol.iterator] === 'function') return input
    throw new QvacErrorAddonBCI({
      code: ERR_CODES.INVALID_STREAM_INPUT,
      adds: 'unsupported input type; expected async iterable, Uint8Array, or chunk array'
    })
  }

  /**
   * Serialize inference runs so a second transcribe() waits until the first
   * response settles. Separate from _withExclusiveRun (lifecycle ops) so
   * destroy/unload can still preempt.
   */
  async _enqueueInference(runFn) {
    const prev = this._inferenceQueueWaiter
    let releaseSlot
    this._inferenceQueueWaiter = new Promise((resolve) => {
      releaseSlot = resolve
    })
    await prev
    let response
    try {
      response = await runFn()
    } catch (err) {
      releaseSlot()
      throw err
    }
    response
      .await()
      .finally(() => {
        releaseSlot()
      })
      .catch(() => {})
    return response
  }

  _assertReadyForInference() {
    if (this.state.destroyed || !this.state.configLoaded || !this.addon) {
      throw new QvacErrorAddonBCI({
        code: ERR_CODES.MODEL_NOT_LOADED,
        adds: this.state.destroyed ? 'instance was destroyed' : 'call load() before transcribe()'
      })
    }
  }

  _isConfigurationError(err) {
    if (err && err.code === 'ERR_ASSERTION') return true
    if (err instanceof TypeError) return true
    const msg = String(err?.message || '')
    return (
      msg.includes('is required') ||
      msg.includes('is not a valid parameter') ||
      msg.includes('must be')
    )
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
  _outputCallback(addon, event, jobId, data, error) {
    if (this._streamWindowHandler) {
      this._streamWindowHandler(event, data, error)
      return
    }
    if (event === ADDON_EVENT.ERROR) {
      this.logger.error('Job ' + jobId + ' failed with error: ' + error)
      this._job.fail(error)
      return
    }
    if (event === ADDON_EVENT.OUTPUT) {
      this._job.output(data)
      return
    }
    if (event === ADDON_EVENT.JOB_ENDED) {
      this.logger.info('Job ' + jobId + ' completed')
      if (this.opts.stats) {
        this._job.end(data)
      } else {
        this._job.end()
      }
      return
    }
    this.logger.debug('Received event for job ' + jobId + ': ' + event)
  }

  async cancel() {
    this._teardownActiveStream('Stream cancelled')
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
    if (this._streamDriverPromise) {
      await this._streamDriverPromise
    }
    if (this._job.active) {
      this._job.fail(new Error('Job cancelled'))
    }
  }

  async unload() {
    return await this._withExclusiveRun(async () => {
      this._teardownActiveStream('Model was unloaded')
      if (this._streamDriverPromise) {
        await this._streamDriverPromise
      }
      await this._inferenceQueueWaiter
      if (this.addon) {
        await this.addon.destroyInstance()
        this.addon = null
      }
      if (this._job.active) {
        this._job.fail(new Error('Model was unloaded'))
      }
      this.state.configLoaded = false
    })
  }

  async destroy() {
    return await this._withExclusiveRun(async () => {
      this._teardownActiveStream('Model was destroyed')
      if (this._streamDriverPromise) {
        await this._streamDriverPromise
      }
      await this._inferenceQueueWaiter
      if (this.addon) {
        await this.addon.destroyInstance()
        this.addon = null
      }
      if (this._job.active) {
        this._job.fail(new Error('Model was destroyed'))
      }
      this.state.configLoaded = false
      this.state.destroyed = true
    })
  }
}

module.exports = BCIWhispercpp
module.exports.BCIWhispercpp = BCIWhispercpp
module.exports.computeWER = computeWER
