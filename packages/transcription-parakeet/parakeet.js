'use strict'

const path = require('bare-path')

const { QvacErrorAddonParakeet, ERR_CODES, END_OF_INPUT } = require('./lib/error')
const { pcmS16ToFloat32, mergeFloat32Chunks } = require('./lib/audio')

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped'
})

function nextSafeId(current) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1
}

// 500 MB — ~2.7 hours of 16 kHz f32le mono audio
const MAX_BUFFERED_BYTES = 500 * 1024 * 1024

function createParakeetError(code, message, cause = undefined) {
  return new QvacErrorAddonParakeet({ code, adds: message, cause })
}

/**
 * Low-level interface between the Bare addon (C++) and the JS
 * runtime. Wraps the ggml-backed Parakeet engine sourced from
 * qvac-parakeet.cpp. The model type is auto-detected from the
 * loaded GGUF's metadata, so there's no `modelType` field on the
 * config -- pass any of CTC / TDT / EOU / Sortformer .gguf files
 * to `loadWeights()` and the right pipeline is chosen automatically.
 */
class ParakeetInterface {
  /**
   * @param {Object} binding - the native binding object
   * @param {Object} configurationParams - inference setup
   * @param {string} [configurationParams.modelPath] - path to a `.gguf`
   *   file (alternative to streaming bytes via `loadWeights()`).
   * @param {number} [configurationParams.maxThreads=4] - max CPU threads (0 = engine picks)
   * @param {boolean} [configurationParams.useGPU=false] - enable the linked ggml GPU backend
   * @param {number} [configurationParams.sampleRate=16000] - audio sample rate
   * @param {number} [configurationParams.channels=1] - audio channels (must be 1 for mono)
   * @param {boolean} [configurationParams.captionEnabled=false] - enable caption/subtitle mode
   * @param {boolean} [configurationParams.timestampsEnabled=true] - include timestamps in output
   * @param {number} [configurationParams.seed=-1] - random seed (-1 for random)
   * @param {boolean} [configurationParams.streaming=false] - open a long-lived
   *   StreamSession / SortformerStreamSession at load() time
   * @param {number} [configurationParams.streamingChunkMs=2000]
   * @param {number} [configurationParams.streamingHistoryMs=30000] - Sortformer rolling history
   * @param {boolean} [configurationParams.streamingEmitPartials=true]
   * @param {boolean} [configurationParams.streamingEnergyVad=false] - CTC/TDT energy-VAD events
   * @param {number} [configurationParams.streamingLeftContextMs] - ASR encoder
   *   left context (parakeet default 10000 ms; -1 keeps the engine default).
   * @param {number} [configurationParams.streamingRightLookaheadMs] - ASR encoder
   *   right lookahead (parakeet default 2000 ms; -1 keeps the engine default).
   * @param {boolean} [configurationParams.streamingSpkCacheEnable=true] - AOSC:
   *   enable v2.1 Sortformer speaker-cache streaming. Ignored on v1/v2 GGUFs
   *   and on non-Sortformer models. Set false to force the v1 sliding-window
   *   path on a v2.1 model (A/B comparison).
   * @param {number} [configurationParams.streamingSpkCacheLen=188] - AOSC:
   *   long-term speaker-cache rows (~15 s of encoder frames).
   * @param {number} [configurationParams.streamingFifoLen=188] - AOSC: FIFO
   *   warmup buffer rows.
   * @param {number} [configurationParams.streamingChunkLeftContextMs=80] -
   *   AOSC: encoder left-context window (ms; ~1 encoder frame).
   * @param {number} [configurationParams.streamingChunkRightContextMs=560] -
   *   AOSC: encoder right-context window (ms; ~7 encoder frames).
   * @param {number} [configurationParams.streamingSpkCacheUpdatePeriod=144] -
   *   AOSC: FIFO-overflow pop-out count.
   * @param {string} [configurationParams.backendsDir] - root directory
   *   for dynamically-loaded ggml backends. JS defaults to
   *   `<package_dir>/prebuilds`; the native addon appends
   *   `<bare-target>/<module-name>` (via the `BACKENDS_SUBDIR` compile
   *   define) before calling `ggml_backend_load_all_from_path()`, which
   *   is where cmake-bare installs the `.so` files
   *   (`libqvac-speech-ggml-vulkan.so`, `libqvac-speech-ggml-opencl.so`,
   *   per-arch `libqvac-speech-ggml-cpu-android_armv*_*.so`). Pass an
   *   explicit path when the host bundles prebuilds elsewhere (e.g. an
   *   Android APK's `nativeLibraryDir`). No-op on Apple targets
   *   (statically linked ggml core).
   * @param {string} [configurationParams.openclCacheDir] - directory where
   *   ggml-opencl persists its compiled program-binary cache (sets
   *   `$GGML_OPENCL_CACHE_DIR`). Only honoured on Android; empty
   *   string keeps whatever value the process env already holds.
   *   Pass the host platform's app cache directory to skip the cold
   *   `clBuildProgram` cost on every process restart.
   * @param {Function} outputCallback - callback for transcription output events
   * @param {Function} [stateCallback] - callback for state transitions
   */
  constructor(binding, configurationParams, outputCallback, stateCallback = null) {
    this._binding = binding
    this._outputCallback = outputCallback
    this._stateCallback = stateCallback
    this._handle = null
    this._state = state.LOADING
    this._nextJobId = 1
    this._activeJobId = null
    this._onCancelComplete = null
    this._bufferedAudio = []
    this._bufferedBytes = 0

    this._config = this._applyDefaults(configurationParams)
    this._createNativeInstance(this._config)
  }

  /**
   * Fall back to `<package_dir>/prebuilds` for `backendsDir` when the
   * host didn't pass one (see the constructor's `backendsDir` doc).
   * @private
   */
  _applyDefaults(configurationParams) {
    const out = { ...configurationParams }
    if (!out.backendsDir) {
      out.backendsDir = path.join(__dirname, 'prebuilds')
    }
    return out
  }

  _setState(newState) {
    this._state = newState
    if (this._stateCallback) {
      this._stateCallback(this, newState)
    }
  }

  _createNativeInstance(configurationParams) {
    this._config = configurationParams
    this._activeJobId = null
    this._onCancelComplete = null
    this._bufferedAudio = []
    this._bufferedBytes = 0
    this._handle = this._binding.createInstance(
      this,
      this._config,
      this._addonOutputCallback.bind(this),
      this._stateCallback
    )
  }

  _looksLikeStats(data) {
    return (
      !!data &&
      typeof data === 'object' &&
      ('totalTime' in data || 'audioDurationMs' in data || 'totalSamples' in data)
    )
  }

  _looksLikeTranscript(data) {
    return (
      Array.isArray(data) || (!!data && typeof data === 'object' && typeof data.text === 'string')
    )
  }

  _mapAddonEvent(event, data, isError) {
    const eventStr = typeof event === 'string' ? event : String(event)
    if (eventStr === 'Error' || eventStr === 'JobEnded' || eventStr === 'Output') return eventStr
    if (isError || eventStr.includes('Error')) return 'Error'
    if (eventStr.includes('RuntimeStats')) return 'JobEnded'
    if (eventStr.includes('Output')) return 'Output'
    if (this._looksLikeStats(data)) return 'JobEnded'
    if (this._looksLikeTranscript(data)) return 'Output'
    return event
  }

  _resolvePendingCancel() {
    if (!this._onCancelComplete) return false
    const resolve = this._onCancelComplete
    this._onCancelComplete = null
    resolve()
    return true
  }

  _addonOutputCallback(addon, event, data, error) {
    const isError = typeof error === 'string' && error.length > 0
    const mappedEvent = this._mapAddonEvent(event, data, isError)
    const isTerminal = mappedEvent === 'Error' || mappedEvent === 'JobEnded'

    const jobId = this._activeJobId
    if (jobId === null) {
      if (isTerminal) this._resolvePendingCancel()
      return
    }

    if (isTerminal && this._resolvePendingCancel()) {
      return
    }

    if (mappedEvent === 'Output') {
      this._setState(state.PROCESSING)
    }

    if (this._outputCallback) {
      this._outputCallback(addon, mappedEvent, jobId, data, isError ? error : null)
    }

    if (isTerminal) {
      this._activeJobId = null
      this._setState(state.LISTENING)
    }
  }

  _emitSyntheticError(jobId, error) {
    if (!this._outputCallback) {
      return
    }
    this._outputCallback(this, 'Error', jobId, undefined, error)
  }

  /**
   * Load model weights
   * @param {Object} weightsData - weight data chunk
   * @param {string} weightsData.filename - name of the weight file
   * @param {Uint8Array} weightsData.chunk - weight data chunk
   * @param {boolean} weightsData.completed - whether this is the last chunk
   * @param {number} [weightsData.progress] - loading progress percentage
   * @param {number} [weightsData.size] - total file size in bytes
   * @returns {Promise<boolean>}
   */
  async loadWeights(weightsData) {
    try {
      return this._binding.loadWeights(this._handle, weightsData)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_LOAD_WEIGHTS, error.message, error)
    }
  }

  /**
   * Activate the model for inference
   * @returns {Promise<void>}
   */
  async activate() {
    try {
      this._binding.activate(this._handle)
      this._setState(state.LISTENING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_ACTIVATE, error.message, error)
    }
  }

  /**
   * Backend the native engine resolved at load(): device class, ggml backend
   * family, and the human-readable GPU name (e.g. "NVIDIA GeForce RTX 3090")
   * recovered from the ggml device registry. The name is the
   * nvidia-smi-independent fallback the perf reporter uses on CI runners.
   * Returns `null` before the instance exists / after destroy.
   * @returns {{ backendDevice: string, backendId: number, backendName: string, backendDescription: string }|null}
   */
  getBackendInfo() {
    if (this._handle == null) return null
    return this._binding.getBackendInfo(this._handle)
  }

  /**
   * Append audio data or end-of-job signal
   * @param {Object} data - data to append
   * @param {string} data.type - 'audio' or 'end of job'
   * @param {ArrayBuffer} [data.data] - audio data buffer (Float32, 16kHz mono)
   * @returns {Promise<number>} - job ID
   */
  async append(data) {
    try {
      if (data?.type === END_OF_INPUT) {
        return this._submitBufferedJob()
      }
      if (data?.type === 'audio') {
        return this._bufferAudioChunk(data.data)
      }
      throw new Error(`Unknown append input type: ${data?.type}`)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  _submitBufferedJob() {
    const currentJobId = this._nextJobId
    const input = this._concatBufferedAudio()
    const previousState = this._state
    let accepted = false
    try {
      accepted = this._binding.runJob(this._handle, { type: 'audio', input })
    } catch (error) {
      this._setState(previousState)
      throw error
    }
    if (!accepted) {
      this._setState(previousState)
      throw new Error('Cannot set new job: a job is already set or being processed')
    }

    this._activeJobId = currentJobId
    this._nextJobId = nextSafeId(this._nextJobId)
    this._bufferedAudio = []
    this._bufferedBytes = 0
    this._setState(state.PROCESSING)
    return currentJobId
  }

  _bufferAudioChunk(rawData) {
    const normalized = this._normalizeAudioInput(rawData)
    if (this._bufferedBytes + normalized.byteLength > MAX_BUFFERED_BYTES) {
      throw createParakeetError(ERR_CODES.BUFFER_LIMIT_EXCEEDED, MAX_BUFFERED_BYTES + ' bytes')
    }
    this._bufferedAudio.push(normalized)
    this._bufferedBytes += normalized.byteLength
    return this._nextJobId
  }

  /**
   * Get current model status (JS-side state-machine value).
   *
   * NOTE: returns the JS wrapper state, not a native query -- there is no
   * `status` RPC in inference-addon-cpp.
   * @returns {Promise<string>} - 'loading', 'listening', 'processing', 'idle', 'paused', 'stopped'
   */
  async status() {
    try {
      return this._state
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_GET_STATUS, error.message, error)
    }
  }

  /**
   * Pause processing.
   *
   * NOTE: JS-side bookkeeping only; does not signal the native engine.
   * Use `cancel()` or `stop()` to actually abort inference.
   * @returns {Promise<void>}
   */
  async pause() {
    try {
      this._setState(state.PAUSED)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_PAUSE, error.message, error)
    }
  }

  /**
   * Stop processing and discard current job
   * @returns {Promise<void>}
   */
  async stop() {
    try {
      this._bufferedAudio = []
      this._bufferedBytes = 0
      if (this._activeJobId !== null) {
        const cancelComplete = new Promise((resolve) => {
          this._onCancelComplete = resolve
        })
        this._activeJobId = null
        await this._binding.cancel(this._handle)
        await cancelComplete
      }
      this._setState(state.STOPPED)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  /**
   * Cancel a specific job
   * @param {number} jobId - job ID to cancel
   * @returns {Promise<void>}
   */
  async cancel(jobId) {
    try {
      const pendingJobId = this._bufferedAudio.length > 0 ? this._nextJobId : null
      const targetJobId = jobId ?? this._activeJobId ?? pendingJobId

      if (targetJobId === null) {
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._setState(state.LISTENING)
        return
      }

      if (this._activeJobId === targetJobId) {
        const cancelComplete = new Promise((resolve) => {
          this._onCancelComplete = resolve
        })
        await this._binding.cancel(this._handle)
        await cancelComplete
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._activeJobId = null
        this._setState(state.LISTENING)
        return
      }

      if (this._activeJobId === null && pendingJobId === targetJobId) {
        this._bufferedAudio = []
        this._bufferedBytes = 0
        this._setState(state.LISTENING)
        this._emitSyntheticError(targetJobId, 'Job cancelled')
      }
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_CANCEL, error.message, error)
    }
  }

  /**
   * Reload model configuration
   * @param {Object} configurationParams - new configuration
   * @returns {Promise<void>}
   */
  async reload(configurationParams) {
    try {
      await this.cancel()
      await this.destroyInstance()
      this._createNativeInstance(configurationParams)
      this._setState(state.LOADING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  /**
   * Unload model weights from memory
   * @returns {Promise<void>}
   */
  async unloadWeights() {
    throw createParakeetError(
      ERR_CODES.FAILED_TO_RESET,
      'unloadWeights is not supported by this package. Use unload() or destroyInstance().'
    )
  }

  async load(configurationParams) {
    try {
      await this.destroyInstance()
      this._createNativeInstance(configurationParams)
      this._setState(state.LOADING)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  async unload() {
    await this.destroyInstance()
  }

  /**
   * Destroy the addon instance and free resources
   * @returns {Promise<void>}
   */
  async destroyInstance() {
    try {
      if (this._handle === null) {
        return
      }
      if (this._activeJobId !== null) {
        try {
          await this._binding.cancel(this._handle)
        } catch {}
      }
      this._binding.destroyInstance(this._handle)
      this._handle = null
      this._activeJobId = null
      this._bufferedAudio = []
      this._bufferedBytes = 0
      this._setState(state.IDLE)
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_DESTROY, error.message, error)
    }
  }

  async runJob(data) {
    const currentJobId = this._nextJobId
    const previousJobId = this._activeJobId
    const previousState = this._state
    try {
      const accepted = this._binding.runJob(this._handle, data)
      if (!accepted) {
        this._activeJobId = previousJobId
        this._setState(previousState)
        return false
      }
      this._activeJobId = currentJobId
      this._nextJobId = nextSafeId(this._nextJobId)
      this._setState(state.PROCESSING)
      return accepted
    } catch (error) {
      this._activeJobId = previousJobId
      this._setState(previousState)
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  /**
   * Open a long-lived duplex streaming session. While the session is
   * open, audio appended via `appendStreamingAudio()` is fed directly
   * into a long-lived `parakeet::StreamSession` (or
   * `SortformerStreamSession`) on the C++ side -- bypassing the
   * `append/runJob/process` batching pipeline used by `append()`. The
   * session emits per-chunk segments through the regular output
   * callback as soon as the engine produces them. Each native streaming
   * session counts as one job for cancellation/state purposes.
   *
   * @param {Object} [config={}]
   * @param {number} [config.chunkMs] - encoder cadence in ms (overrides cfg.streamingChunkMs)
   * @param {number} [config.historyMs] - Sortformer rolling history (overrides cfg.streamingHistoryMs)
   * @param {number} [config.leftContextMs] - ASR encoder left context (overrides cfg.streamingLeftContextMs)
   * @param {number} [config.rightLookaheadMs] - ASR encoder right lookahead (overrides cfg.streamingRightLookaheadMs)
   * @param {boolean} [config.emitPartials] - emit partial segments on chunk boundaries
   * @param {boolean} [config.emitEnergyVad] - surface energy-VAD events for CTC/TDT
   * @param {boolean} [config.spkCacheEnable] - AOSC: enable/disable v2.1 speaker cache (overrides cfg.streamingSpkCacheEnable)
   * @param {number} [config.spkCacheLen] - AOSC: long-term speaker-cache rows (overrides cfg.streamingSpkCacheLen)
   * @param {number} [config.fifoLen] - AOSC: FIFO warmup buffer rows (overrides cfg.streamingFifoLen)
   * @param {number} [config.chunkLeftContextMs] - AOSC: encoder left-context window in ms (overrides cfg.streamingChunkLeftContextMs)
   * @param {number} [config.chunkRightContextMs] - AOSC: encoder right-context window in ms (overrides cfg.streamingChunkRightContextMs)
   * @param {number} [config.spkCacheUpdatePeriod] - AOSC: FIFO-overflow pop-out count (overrides cfg.streamingSpkCacheUpdatePeriod)
   * @returns {Promise<number>} jobId assigned to the streaming session
   */
  async startStreaming(config = {}) {
    try {
      if (this._activeJobId !== null) {
        throw new Error('Cannot start streaming: a job is already active. Call cancel() first.')
      }
      const currentJobId = this._nextJobId
      this._activeJobId = currentJobId
      this._nextJobId = nextSafeId(this._nextJobId)
      try {
        this._binding.startStreaming(this._handle, config)
      } catch (error) {
        this._activeJobId = null
        throw error
      }
      this._setState(state.PROCESSING)
      return currentJobId
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  /**
   * Push an audio chunk into the active streaming session.
   * @param {Float32Array|Int16Array|ArrayBuffer|TypedArray} data - audio samples
   * @returns {Promise<boolean>} true if the chunk was accepted
   */
  async appendStreamingAudio(data) {
    try {
      if (this._activeJobId === null) {
        throw new Error('No active streaming session; call startStreaming() first.')
      }
      const samples = this._normalizeAudioInput(data)
      return this._binding.appendStreamingAudio(this._handle, {
        type: 'audio',
        input: samples
      })
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_APPEND, error.message, error)
    }
  }

  /**
   * Gracefully close the active streaming session: trailing audio is
   * flushed via `finalize()`, last segments are emitted via the output
   * callback, then a synthetic JobEnded is delivered so the addon-cpp
   * response chain (`onUpdate().await()`) resolves cleanly.
   * @returns {Promise<void>}
   */
  async endStreaming() {
    try {
      if (this._activeJobId === null) return
      const jobId = this._activeJobId
      // Native teardown returns stats captured before the worker joined.
      const teardown = this._binding.endStreaming(this._handle) || {}
      // Streaming bypasses the runtimeStats path, so emit JobEnded manually.
      this._activeJobId = null
      this._setState(state.LISTENING)
      if (this._outputCallback) {
        this._outputCallback(
          this,
          'JobEnded',
          jobId,
          {
            totalTime: 0,
            audioDurationMs:
              typeof teardown.audioDurationMs === 'number' ? teardown.audioDurationMs : 0,
            totalSamples: typeof teardown.totalSamples === 'number' ? teardown.totalSamples : 0
          },
          null
        )
      }
    } catch (error) {
      throw createParakeetError(ERR_CODES.FAILED_TO_RESET, error.message, error)
    }
  }

  /**
   * Forcefully abort an active streaming session. Aliased through
   * `cancel()` on the binding so the C++ side runs the
   * cancelWithStreaming wrapper which tears down the StreamingProcessor
   * and falls through to the framework's regular cancel.
   * @returns {Promise<void>}
   */
  async cancelStreaming() {
    return this.cancel()
  }

  _normalizeAudioInput(data) {
    if (!data) {
      throw new Error('Audio input is required')
    }
    if (data instanceof Float32Array) {
      return data
    }
    if (ArrayBuffer.isView(data)) {
      if (data instanceof Int16Array) {
        return pcmS16ToFloat32(data)
      }
      return new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
    }
    if (data instanceof ArrayBuffer) {
      return new Float32Array(data)
    }
    throw new Error('Unsupported audio input format')
  }

  _concatBufferedAudio() {
    if (this._bufferedAudio.length === 0) {
      return new Float32Array(0)
    }
    if (this._bufferedAudio.length === 1) {
      return this._bufferedAudio[0]
    }
    return mergeFloat32Chunks(this._bufferedAudio)
  }
}

module.exports = { ParakeetInterface, QvacErrorAddonParakeet, ERR_CODES }
