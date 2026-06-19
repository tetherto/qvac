'use strict'

const { platform } = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const QvacLogger = require('@qvac/logging')
const {
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition: inferGetApiDefinition
} = require('@qvac/infer-base')
const { TTSInterface } = require('./tts')
const { QvacErrorAddonTTSGgml, ERR_CODES } = require('./lib/error')
const { splitTtsText } = require('./lib/textChunker')
const { accumulateTextStream } = require('./lib/textStreamAccumulator')

const ENGINE_CHATTERBOX = 'chatterbox'
const ENGINE_SUPERTONIC = 'supertonic'

const CHATTERBOX_T3_TURBO = 'chatterbox-t3-turbo.gguf'
const CHATTERBOX_T3_MTL = 'chatterbox-t3-mtl.gguf'
const CHATTERBOX_S3GEN_DEFAULT = 'chatterbox-s3gen.gguf'
const CHATTERBOX_S3GEN_MTL = 'chatterbox-s3gen-mtl.gguf'
const SUPERTONIC_DEFAULT = 'supertonic.gguf'
const SUPERTONIC_MTL = 'supertonic2.gguf'
// Supertonic 3 (31-language).  Same thin engine as v1/v2 — the architecture
// and quantisation are read from the GGUF metadata by tts-cpp at load time, so
// the addon only needs to recognise the filename for the modelDir auto-detect
// path (explicit `files.supertonicModel` paths bypass this and already route
// to the Supertonic engine).  Unlike v1/v2 (which keep a single historical
// bare `supertonic.gguf` / `supertonic2.gguf` on disk), the v3 GGUFs are
// published per quant tier with the quant in the filename
// (`supertonic3-f16.gguf`, `supertonic3-q8_0.gguf`, ...), so the modelDir
// lookup matches any `supertonic3[-<quant>].gguf` (see findSupertonicV3InDir).
const SUPERTONIC_V3_RE = /^supertonic3(-[a-z0-9_]+)?\.gguf$/i
// Preference when several v3 tiers share a modelDir: highest precision first.
const SUPERTONIC_V3_QUANT_ORDER = ['f16', 'f32', 'q8_0', 'q4_0']

function firstNonEmpty (...candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i]
    if (v != null && v !== '') return v
  }
  return undefined
}

function fileExistsSafe (p) {
  if (!p) return false
  try {
    return fs.existsSync(p)
  } catch (_e) {
    return false
  }
}

/**
 * Find a Supertonic 3 GGUF inside `modelDir`.  The v3 models are published
 * per quant tier with the quant baked into the filename
 * (`supertonic3-f16.gguf`, `supertonic3-q8_0.gguf`, ...), so a plain
 * `supertonic3.gguf` lookup never matches.  Match any tier present, preferring
 * a bare `supertonic3.gguf` (forward-compat) and then highest precision.
 * Returns the absolute path of the chosen file, or undefined when none exist.
 *
 * @param {string|undefined} modelDir
 * @returns {string|undefined}
 */
function findSupertonicV3InDir (modelDir) {
  if (!modelDir) return undefined
  let entries
  try {
    entries = fs.readdirSync(modelDir)
  } catch (_e) {
    return undefined
  }
  const matches = entries.filter((n) => SUPERTONIC_V3_RE.test(n))
  if (matches.length === 0) return undefined
  const rank = (n) => {
    if (/^supertonic3\.gguf$/i.test(n)) return 0
    const m = n.match(/^supertonic3-(.+)\.gguf$/i)
    const idx = m ? SUPERTONIC_V3_QUANT_ORDER.indexOf(m[1].toLowerCase()) : -1
    return idx === -1 ? SUPERTONIC_V3_QUANT_ORDER.length + 1 : idx + 1
  }
  matches.sort((a, b) => rank(a) - rank(b))
  return path.join(modelDir, matches[0])
}

/**
 * Normalize the `files` map into the GGUF paths each engine variant needs.
 * Accepts:
 *   - Chatterbox: explicit `t3Model`/`s3genModel`, or a `modelDir` that
 *     contains either the turbo (`chatterbox-t3-turbo.gguf` +
 *     `chatterbox-s3gen.gguf`) or multilingual
 *     (`chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf`) GGUFs.
 *   - Supertonic: explicit `supertonicModel`, or a `modelDir` that
 *     contains `supertonic.gguf`.
 *
 * @param {Record<string, unknown>} files
 */
function normalizeGgmlFiles (files) {
  if (files == null || typeof files !== 'object') {
    return {}
  }
  const f = files
  return {
    modelDir: firstNonEmpty(f.modelDir),
    t3Model: firstNonEmpty(f.t3Model, f.t3ModelPath, f.t3),
    s3genModel: firstNonEmpty(f.s3genModel, f.s3genModelPath, f.s3gen),
    supertonicModel: firstNonEmpty(
      f.supertonicModel,
      f.supertonicModelPath,
      f.supertonic
    ),
    voicesDir: firstNonEmpty(f.voicesDir),
    // Directory of the compiled MeCab/IPAdic dictionary (Japanese) and
    // the Cangjie TSV (Chinese).  The host resolves/stages these (e.g.
    // from the QVAC model registry) and passes the local paths; the
    // addon only forwards them to tts-cpp's EngineOptions.
    mecabDictDir: firstNonEmpty(f.mecabDictDir, f.mecabDictPath),
    cangjieTsvPath: firstNonEmpty(f.cangjieTsvPath, f.cangjieTsv)
  }
}

/**
 * Decide which engine the constructor should drive.  Order of precedence:
 *   1. Explicit `engine` option (caller-asserted: 'chatterbox' | 'supertonic').
 *   2. An explicit Supertonic file path.
 *   3. A `modelDir` that contains `supertonic.gguf` on disk.
 *   4. Default → Chatterbox (turbo or MTL is decided later inside the
 *      Chatterbox path resolver based on which T3 file is present).
 */
function detectEngineType (engine, normalizedFiles) {
  if (engine === ENGINE_CHATTERBOX || engine === ENGINE_SUPERTONIC) {
    return engine
  }
  if (engine != null && engine !== '') {
    throw new Error(
      "tts-ggml: 'engine' option must be 'chatterbox' or 'supertonic' " +
        "(got '" + engine + "')"
    )
  }
  if (normalizedFiles.t3Model || normalizedFiles.s3genModel) return ENGINE_CHATTERBOX
  if (normalizedFiles.supertonicModel) return ENGINE_SUPERTONIC
  if (normalizedFiles.modelDir) {
    const turboT3 = path.join(normalizedFiles.modelDir, CHATTERBOX_T3_TURBO)
    const mtlT3 = path.join(normalizedFiles.modelDir, CHATTERBOX_T3_MTL)
    const supertonicEn = path.join(normalizedFiles.modelDir, SUPERTONIC_DEFAULT)
    const supertonicMtl = path.join(normalizedFiles.modelDir, SUPERTONIC_MTL)
    const supertonicV3 = findSupertonicV3InDir(normalizedFiles.modelDir)
    const hasChatterbox = fileExistsSafe(turboT3) || fileExistsSafe(mtlT3)
    const hasSupertonic = fileExistsSafe(supertonicEn) || fileExistsSafe(supertonicMtl) ||
      !!supertonicV3
    if (hasChatterbox) return ENGINE_CHATTERBOX
    if (hasSupertonic) return ENGINE_SUPERTONIC
  }
  return ENGINE_CHATTERBOX
}

/**
 * Pick the right Supertonic GGUF inside `modelDir`.
 * Mirrors the chatterbox resolver: prefer the English-only build when
 * present (smaller, single-language), only fall back to the multilingual
 * build when English isn't on disk.  Callers that explicitly want the
 * multilingual variant should pass `files.supertonicModel` directly.
 */
function resolveSupertonicModelDirPath (modelDir) {
  const supertonicEn = path.join(modelDir, SUPERTONIC_DEFAULT)
  const supertonicMtl = path.join(modelDir, SUPERTONIC_MTL)
  const supertonicV3 = findSupertonicV3InDir(modelDir)
  if (fileExistsSafe(supertonicEn)) return supertonicEn
  if (fileExistsSafe(supertonicMtl)) return supertonicMtl
  if (supertonicV3) return supertonicV3
  return supertonicEn
}

/**
 * Pick the right Chatterbox T3 + S3Gen file names inside `modelDir`.
 * Multilingual GGUFs win when both variants are present (only-mtl is
 * the only state where mtl beats turbo at the file-detection layer).
 * Otherwise fall back to the turbo English layout.
 */
function resolveChatterboxModelDirPaths (modelDir) {
  const turboT3 = path.join(modelDir, CHATTERBOX_T3_TURBO)
  const mtlT3 = path.join(modelDir, CHATTERBOX_T3_MTL)
  const defaultS3 = path.join(modelDir, CHATTERBOX_S3GEN_DEFAULT)
  const mtlS3 = path.join(modelDir, CHATTERBOX_S3GEN_MTL)

  const hasTurbo = fileExistsSafe(turboT3)
  const hasMtl = fileExistsSafe(mtlT3)
  if (hasMtl && !hasTurbo) {
    return {
      t3: mtlT3,
      s3: fileExistsSafe(mtlS3) ? mtlS3 : defaultS3
    }
  }
  return { t3: turboT3, s3: defaultS3 }
}

/**
 * Default `accumulateSentences` for `runStreaming`: true only for native `AsyncIterable`
 * (e.g. incremental text from an upstream async source), not for strings, arrays, or sync-only iterables.
 * @param {unknown} textStream
 * @returns {boolean}
 */
function defaultAccumulateSentencesForStreamInput (textStream) {
  if (textStream == null) return false
  if (typeof textStream === 'string') return false
  if (Array.isArray(textStream)) return false
  if (typeof textStream[Symbol.asyncIterator] === 'function') return true
  return false
}

function ttsOutputDebugString (data) {
  if (!data) return ''
  if (typeof data !== 'object') return data.toString()
  // Skip the heavy fields (outputArray = Int16Array of 24 kHz PCM
  // samples; for native chunk streaming each event carries thousands of
  // samples and JSON.stringify becomes the dominant cost on the
  // outputCallback fast path). Surface only the summary fields so
  // logger.debug stays useful.
  const summary = {}
  if (data.sampleRate != null) summary.sampleRate = data.sampleRate
  if (data.chunkIndex != null) summary.chunkIndex = data.chunkIndex
  if (data.isLast != null) summary.isLast = data.isLast
  if (data.sentenceChunk != null) summary.sentenceChunk = data.sentenceChunk
  if (data.outputArray && typeof data.outputArray.length === 'number') {
    summary.outputArrayLen = data.outputArray.length
  }
  return JSON.stringify(summary)
}

/**
 * GGML-backed Chatterbox TTS (via the `tts-cpp` / qvac-tts.cpp library).
 *
 * Owns a persistent native engine — T3, S3Gen, and any voice-conditioning
 * tensors are loaded once at `load()` and reused across every `run()` /
 * `runStream()` / `runStreaming()` call.  Exposes batch synthesis
 * (`run({ input })`), sentence-granularity streaming (`runStreaming()` over
 * an async iterator of sentences), and sub-sentence native chunk streaming
 * (set `streamChunkTokens` on the constructor; the C++ Engine then emits
 * PCM per chunk as it's produced).  See README.md for usage.
 */
class TTSGgml {
  constructor (options = {}) {
    const {
      files: filesInput = {},
      config = {},
      logger,
      lazySessionLoading,
      engine,
      referenceAudio,
      voiceDir,
      seed,
      nGpuLayers,
      nCtx,
      kvCacheType,
      threads,
      streamChunkTokens,
      streamFirstChunkTokens,
      cfmSteps,
      voice,
      voiceName,
      steps,
      numInferenceSteps,
      speed,
      noiseNpyPath,
      backendsDir,
      openclCacheDir,
      mecabDictDir,
      mecabDictPath,
      cangjieTsvPath,
      opts,
      exclusiveRun
    } = options

    this.opts = opts || {}
    this.exclusiveRun = !!exclusiveRun
    this.logger = new QvacLogger(logger)
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false
    }
    this.addon = null
    this._sentenceStreamCtx = null
    /** Serializes `run({ streamOutput: true })`, `runStream`, and `runStreaming` until each response settles (Whisper-style). */
    this._ttsInferenceQueueWaiter = Promise.resolve()
    this._job = createJobHandler({
      cancel: () => {
        const a = this.addon
        return a ? a.cancel() : undefined
      }
    })
    this._runExclusive = this.exclusiveRun
      ? exclusiveRunQueue()
      : async function runNow (fn) {
        return fn()
      }

    const normalizedFiles = normalizeGgmlFiles(filesInput)
    this._config = { ...config }

    this._lazySessionLoading = lazySessionLoading != null
      ? lazySessionLoading
      : (platform() === 'ios' || platform() === 'android')

    const outputSampleRate = this._config.outputSampleRate
    if (outputSampleRate != null && (outputSampleRate < 8000 || outputSampleRate > 192000)) {
      throw new Error('outputSampleRate must be between 8000 and 192000, got ' + outputSampleRate)
    }
    this._outputSampleRate = outputSampleRate || null

    this._engineType = detectEngineType(engine, normalizedFiles)
    this._voicesDir = normalizedFiles.voicesDir

    if (this._engineType === ENGINE_SUPERTONIC) {
      const root = normalizedFiles.modelDir
      this._supertonicModelPath = firstNonEmpty(
        normalizedFiles.supertonicModel,
        root ? resolveSupertonicModelDirPath(root) : undefined
      )
      this._t3ModelPath = undefined
      this._s3genModelPath = undefined
    } else {
      const root = normalizedFiles.modelDir
      if (root) {
        const resolved = resolveChatterboxModelDirPaths(root)
        this._t3ModelPath = firstNonEmpty(
          normalizedFiles.t3Model,
          resolved.t3
        )
        this._s3genModelPath = firstNonEmpty(
          normalizedFiles.s3genModel,
          resolved.s3
        )
      } else {
        this._t3ModelPath = normalizedFiles.t3Model
        this._s3genModelPath = normalizedFiles.s3genModel
      }
      this._supertonicModelPath = undefined
    }

    // Multilingual preprocessing dictionaries (Chatterbox MTL only).
    // Accept either a top-level option or a `files.*` entry; the host
    // resolves/stages them (e.g. from the QVAC model registry) and the
    // addon forwards the local paths to tts-cpp.
    this._mecabDictPath = firstNonEmpty(
      mecabDictPath,
      mecabDictDir,
      normalizedFiles.mecabDictDir
    )
    this._cangjieTsvPath = firstNonEmpty(
      cangjieTsvPath,
      normalizedFiles.cangjieTsvPath
    )

    this._referenceAudio = referenceAudio
    this._voiceDir = voiceDir
    this._seed = seed
    this._nGpuLayers = nGpuLayers
    this._nCtx = nCtx
    this._kvCacheType = kvCacheType
    this._threads = threads
    this._streamChunkTokens = streamChunkTokens
    this._streamFirstChunkTokens = streamFirstChunkTokens
    this._cfmSteps = cfmSteps
    this._voice = firstNonEmpty(voice, voiceName)
    this._steps = firstNonEmpty(steps, numInferenceSteps)
    this._speed = speed
    this._noiseNpyPath = noiseNpyPath

    // Per-platform fallback for `backendsDir` when the host didn't
    // pass one. Mirrors the qvac/packages/llm-llamacpp +
    // transcription-parakeet resolution shape
    this._backendsDir = firstNonEmpty(
      backendsDir,
      this._config?.backendsDir,
      path.join(__dirname, 'prebuilds')
    )
    this._openclCacheDir = firstNonEmpty(
      openclCacheDir,
      this._config?.openclCacheDir
    )

    // Run the conflict check before any engine-specific GPU policy so a
    // caller passing { useGPU:false, nGpuLayers:99 } gets the precise
    // conflict message instead of, e.g., the Supertonic "GPU not
    // supported" branch firing on `nGpuLayers > 0` and confusing them.
    // `layers != 0` (rather than `layers > 0`) so a future llama.cpp-
    // style `nGpuLayers: -1` ("offload all layers") doesn't falsely
    // pass through as "wants CPU" against an explicit useGPU:true.
    if (
      typeof this._config.useGPU === 'boolean' &&
      this._nGpuLayers != null
    ) {
      const layersWantGpu = this._nGpuLayers !== 0
      if (this._config.useGPU !== layersWantGpu) {
        throw new Error(
          'tts-ggml: useGPU=' + this._config.useGPU +
          ' conflicts with nGpuLayers=' + this._nGpuLayers + '. ' +
          'Either drop one of the two, or make them agree ' +
          '(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).'
        )
      }
    }

    if (this._engineType === ENGINE_SUPERTONIC) {
      if (this._streamChunkTokens != null || this._streamFirstChunkTokens != null) {
        throw new Error(
          'tts-ggml: streamChunkTokens / streamFirstChunkTokens are Chatterbox-only ' +
          'options (sub-sentence native streaming via the chatterbox::Engine ' +
          'streaming chunked S3Gen+HiFT loop). Supertonic does not support sub-' +
          'sentence native streaming; use sentence-level streaming via the engine-' +
          'agnostic runStream() / runStreaming() / run({ streamOutput: true }) APIs.'
        )
      }
    }
    // Default GPU off only when neither knob is set, for every engine. A
    // caller passing nGpuLayers alone keeps it (no silent conflict with the
    // JS-side default). Supertonic GPU intent now flows through to tts-cpp on
    // GPU-capable hosts (Metal / Vulkan / CUDA); on Android it is forced back
    // to CPU at the native engine boundary (SupertonicModel::loadLocked) until
    // the Adreno OpenCL/Vulkan path stabilizes.
    if (this._config.useGPU === undefined && this._nGpuLayers == null) {
      this._config.useGPU = false
    }
  }

  getEngineType () {
    return this._engineType
  }

  getApiDefinition () {
    const api = inferGetApiDefinition()
    this.logger.debug(
      `Using API definition: ${api} for platform: ${platform()}`
    )
    return api
  }

  getState () {
    return this.state
  }

  async load (..._args) {
    if (this.state.destroyed) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: 'instance was destroyed'
      })
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this.logger.info('Reload requested - unloading existing model first')
      await this.unload()
    }
    await this._load()
    this.state.configLoaded = true
    this.state.weightsLoaded = true
  }

  /**
   * Run text-to-speech.  Set `streamOutput: true` to split `input` into sentence
   * chunks and emit PCM on `response.onUpdate` as each chunk completes (same
   * behavior as `runStream`).
   *
   * @param {Object} input
   * @param {string} input.input - Text to synthesize
   * @param {boolean} [input.streamOutput=false] - Chunked streaming output
   * @param {string} [input.locale] - BCP-47 locale for chunking when `streamOutput`
   * @param {number} [input.maxChunkScalars] - Max graphemes per chunk when `streamOutput`
   */
  async run (input) {
    if (input && typeof input === 'object' && input.streamOutput === true) {
      if (typeof input.input !== 'string' || input.input.trim().length === 0) {
        throw new QvacErrorAddonTTSGgml({
          code: ERR_CODES.FAILED_TO_APPEND,
          adds: 'run with streamOutput: non-empty string `input` is required'
        })
      }
      const streamOpts = {
        locale: input.locale,
        maxChunkScalars: input.maxChunkScalars
      }
      if (this.exclusiveRun) {
        return await this._enqueueExclusiveTtsResponse(() =>
          this._runStreamOrchestrator(input.input, streamOpts)
        )
      }
      return this._runStreamOrchestrator(input.input, streamOpts)
    }
    return this._runExclusive(() => this._runInternal(input))
  }

  /**
   * Serialize streaming runs until the returned {@link QvacResponse} settles.
   */
  async _enqueueExclusiveTtsResponse (runFn) {
    const prev = this._ttsInferenceQueueWaiter || Promise.resolve()
    let releaseSlot
    this._ttsInferenceQueueWaiter = new Promise(resolve => {
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
    response.await().finally(() => { releaseSlot() }).catch(() => {})
    return response
  }

  /**
   * Chunk long text by sentence (see {@link splitTtsText}), synthesize each chunk
   * in order, and emit PCM on `response.onUpdate` as each chunk completes.
   * Equivalent to `run({ input: text, streamOutput: true, ...options })`.
   *
   * @param {string} text
   * @param {{ locale?: string, maxChunkScalars?: number }} [options]
   */
  async runStream (text, options = {}) {
    const opts = options == null || typeof options !== 'object' ? {} : options
    return this.run({
      input: text,
      streamOutput: true,
      locale: opts.locale,
      maxChunkScalars: opts.maxChunkScalars
    })
  }

  /**
   * Streaming input + streaming output: each flushed string is one synthesis job;
   * PCM is emitted on `response.onUpdate` per job.  Same chunk metadata shape as
   * `runStream`.
   *
   * For **AsyncIterable** inputs, **`accumulateSentences` defaults to true**:
   * fragments are concatenated until a sentence end (see
   * `sentenceDelimiterPreset`), max buffer size (`maxBufferScalars`), or
   * `flushAfterMs` idle after the last fragment.  Strings and arrays default to
   * one job per yield (`accumulateSentences` false).
   *
   * @param {AsyncIterable<string>|Iterable<string>|string} textStream
   * @param {Object} [options]
   * @param {boolean} [options.accumulateSentences] - Default: true for `AsyncIterable` inputs only.
   * @param {'latin'|'cjk'|'multilingual'} [options.sentenceDelimiterPreset]
   * @param {RegExp} [options.sentenceDelimiter] - Overrides preset when set (tested against full buffer).
   * @param {number} [options.maxBufferScalars] - Max graphemes before hard flush (default by language).
   * @param {number} [options.flushAfterMs] - Idle flush after last fragment (default 500).
   */
  async runStreaming (textStream, options = {}) {
    const streamOpts = this._resolveRunStreamingOptions(textStream, options)
    let normalized = this._normalizeTextStream(textStream)
    if (streamOpts.accumulateSentences) {
      normalized = accumulateTextStream(normalized, {
        sentenceDelimiterPreset: streamOpts.sentenceDelimiterPreset,
        maxBufferScalars: streamOpts.maxBufferScalars,
        flushAfterMs: streamOpts.flushAfterMs,
        sentenceDelimiter: streamOpts.sentenceDelimiter,
        language: this._config?.language
      })
    }
    if (this.exclusiveRun) {
      return await this._enqueueExclusiveTtsResponse(() =>
        this._runTextStreamOrchestrator(normalized)
      )
    }
    return this._runTextStreamOrchestrator(normalized)
  }

  _resolveRunStreamingOptions (textStream, options) {
    const o = options == null || typeof options !== 'object' ? {} : options
    let accumulateSentences = o.accumulateSentences
    if (accumulateSentences === undefined) {
      accumulateSentences = defaultAccumulateSentencesForStreamInput(textStream)
    }
    const rawPreset = o.sentenceDelimiterPreset
    const sentenceDelimiterPreset =
      rawPreset === 'latin' || rawPreset === 'cjk' || rawPreset === 'multilingual'
        ? rawPreset
        : 'multilingual'
    const maxBufferScalars = o.maxBufferScalars
    const flushAfterMs = o.flushAfterMs != null ? o.flushAfterMs : 500
    const sentenceDelimiter =
      o.sentenceDelimiter instanceof RegExp ? o.sentenceDelimiter : undefined
    return {
      accumulateSentences: !!accumulateSentences,
      sentenceDelimiterPreset,
      maxBufferScalars,
      flushAfterMs,
      sentenceDelimiter
    }
  }

  _normalizeTextStream (textStream) {
    if (textStream == null) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: 'runStreaming: text stream is required'
      })
    }
    if (typeof textStream === 'string') {
      async function * oneString () {
        yield textStream
      }
      return oneString()
    }
    if (typeof textStream[Symbol.asyncIterator] === 'function') {
      return textStream
    }
    if (Array.isArray(textStream)) {
      async function * fromArray () {
        for (let i = 0; i < textStream.length; i++) {
          yield textStream[i]
        }
      }
      return fromArray()
    }
    if (typeof textStream[Symbol.iterator] === 'function') {
      async function * fromIterable () {
        for (const x of textStream) {
          yield x
        }
      }
      return fromIterable()
    }
    throw new QvacErrorAddonTTSGgml({
      code: ERR_CODES.FAILED_TO_APPEND,
      adds: 'runStreaming: expected string, array of strings, Iterable, or AsyncIterable'
    })
  }

  _runTextStreamOrchestrator (asyncTextSource) {
    const response = this._job.start()
    this._sentenceStreamCtx = {
      textStreamMode: true,
      asyncTextSource,
      chunks: [],
      chunkIdx: 0,
      acc: {
        totalTime: 0,
        audioDurationMs: 0,
        totalSamples: 0
      },
      chunkResolver: null
    }

    this._sentenceStreamTextIterableDrive().catch((err) => {
      if (this._sentenceStreamCtx && this._sentenceStreamCtx.chunkResolver) {
        const rej = this._sentenceStreamCtx.chunkResolver.reject
        this._sentenceStreamCtx.chunkResolver = null
        rej(err)
      }
      this._sentenceStreamCtx = null
      this._job.fail(err)
    })

    return response
  }

  async _sentenceStreamTextIterableDrive () {
    const ctx = this._sentenceStreamCtx
    if (!ctx || !ctx.textStreamMode) return
    try {
      for await (const piece of ctx.asyncTextSource) {
        const s = String(piece).trim()
        if (s.length === 0) continue
        ctx.chunks.push(s)
        ctx.chunkIdx = ctx.chunks.length - 1
        const donePromise = new Promise((resolve, reject) => {
          ctx.chunkResolver = { resolve, reject }
        })
        await this.addon.runJob({
          type: 'text',
          input: s
        })
        await donePromise
      }
    } catch (err) {
      if (this._sentenceStreamCtx && this._sentenceStreamCtx.chunkResolver) {
        const rej = this._sentenceStreamCtx.chunkResolver.reject
        this._sentenceStreamCtx.chunkResolver = null
        rej(err)
      }
      this._sentenceStreamCtx = null
      this._job.fail(err)
      return
    }

    const chunks = this._sentenceStreamCtx ? this._sentenceStreamCtx.chunks : []
    const acc = this._sentenceStreamCtx
      ? this._sentenceStreamCtx.acc
      : { totalTime: 0, audioDurationMs: 0, totalSamples: 0 }
    this._sentenceStreamCtx = null

    if (chunks.length === 0) {
      if (this.opts?.stats) {
        this._job.end({
          totalTime: 0,
          tokensPerSecond: 0,
          realTimeFactor: 0,
          audioDurationMs: 0,
          totalSamples: 0
        })
      } else {
        this._job.end()
      }
      return
    }

    const totalChars = chunks.join('').length
    const merged = { ...acc }
    merged.tokensPerSecond = acc.totalTime > 0 ? totalChars / acc.totalTime : 0
    merged.realTimeFactor =
      acc.audioDurationMs > 0 ? (acc.totalTime * 1000.0) / acc.audioDurationMs : 0
    if (this.opts?.stats) {
      this._job.end(merged)
    } else {
      this._job.end()
    }
  }

  _runStreamOrchestrator (text, options) {
    const chunks = splitTtsText(String(text), {
      language: this._config?.language,
      locale: options.locale,
      maxScalars: options.maxChunkScalars
    })
    if (chunks.length === 0) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: 'chunked synthesis: text produced no chunks after split'
      })
    }

    const response = this._job.start()
    this._sentenceStreamCtx = {
      chunks,
      chunkIdx: 0,
      acc: {
        totalTime: 0,
        audioDurationMs: 0,
        totalSamples: 0
      },
      chunkResolver: null
    }

    this._sentenceStreamDriveBody().catch((err) => {
      if (this._sentenceStreamCtx && this._sentenceStreamCtx.chunkResolver) {
        const rej = this._sentenceStreamCtx.chunkResolver.reject
        this._sentenceStreamCtx.chunkResolver = null
        rej(err)
      }
      this._sentenceStreamCtx = null
      this._job.fail(err)
    })

    return response
  }

  async _sentenceStreamDriveBody () {
    const ctx = this._sentenceStreamCtx
    if (!ctx || ctx.textStreamMode) return
    for (let i = 0; i < ctx.chunks.length; i++) {
      ctx.chunkIdx = i
      const donePromise = new Promise((resolve, reject) => {
        ctx.chunkResolver = { resolve, reject }
      })
      await this.addon.runJob({
        type: 'text',
        input: ctx.chunks[i]
      })
      await donePromise
    }
    this._sentenceStreamCtx = null
  }

  async _load () {
    this.logger.info('[TTSGgml] Language:', this._config?.language || 'en')

    const ttsParams = this._buildTtsParams()

    this.addon = this._createAddon(ttsParams, this._addonOutputCallback.bind(this))
    await this.addon.activate()
  }

  _buildTtsParams () {
    if (this._engineType === ENGINE_SUPERTONIC) {
      return this._buildSupertonicParams()
    }
    return this._buildChatterboxParams()
  }

  _buildChatterboxParams () {
    const params = {
      engineType: ENGINE_CHATTERBOX,
      t3ModelPath: this._t3ModelPath || '',
      s3genModelPath: this._s3genModelPath || '',
      language: this._config?.language || 'en'
    }
    if (this._referenceAudio != null) {
      params.referenceAudio = this._referenceAudio
    }
    if (this._voiceDir != null) {
      params.voiceDir = this._voiceDir
    }
    if (this._seed != null) params.seed = this._seed | 0
    if (this._nGpuLayers != null) params.nGpuLayers = this._nGpuLayers | 0
    if (this._nCtx != null) params.nCtx = this._nCtx | 0
    if (this._kvCacheType != null) params.kvCacheType = String(this._kvCacheType)
    if (this._threads != null) params.threads = this._threads | 0
    if (this._streamChunkTokens != null) params.streamChunkTokens = this._streamChunkTokens | 0
    if (this._streamFirstChunkTokens != null) {
      params.streamFirstChunkTokens = this._streamFirstChunkTokens | 0
    }
    if (this._cfmSteps != null) params.cfmSteps = this._cfmSteps | 0
    if (this._outputSampleRate != null) {
      params.outputSampleRate = this._outputSampleRate | 0
    }
    if (this._config?.useGPU != null) {
      params.useGPU = !!this._config.useGPU
    }
    if (this._backendsDir) params.backendsDir = this._backendsDir
    if (this._openclCacheDir) params.openclCacheDir = this._openclCacheDir
    if (this._mecabDictPath) params.mecabDictPath = this._mecabDictPath
    if (this._cangjieTsvPath) params.cangjieTsvPath = this._cangjieTsvPath
    return params
  }

  _buildSupertonicParams () {
    const params = {
      engineType: ENGINE_SUPERTONIC,
      supertonicModelPath: this._supertonicModelPath || '',
      language: this._config?.language || 'en'
    }
    if (this._voice) params.voice = this._voice
    if (this._steps != null) params.steps = this._steps | 0
    if (this._speed != null) params.speed = Number(this._speed)
    if (this._seed != null) params.seed = this._seed | 0
    if (this._threads != null) params.threads = this._threads | 0
    if (this._nGpuLayers != null) params.nGpuLayers = this._nGpuLayers | 0
    if (this._outputSampleRate != null) {
      params.outputSampleRate = this._outputSampleRate | 0
    }
    if (this._config?.useGPU != null) {
      params.useGPU = !!this._config.useGPU
    }
    if (this._noiseNpyPath) params.noiseNpyPath = this._noiseNpyPath
    if (this._backendsDir) params.backendsDir = this._backendsDir
    if (this._openclCacheDir) params.openclCacheDir = this._openclCacheDir
    return params
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams
   * @param {Function} outputCb
   * @returns {TTSInterface}
   */
  _createAddon (configurationParams, outputCb) {
    const binding = require('./binding')
    return new TTSInterface(binding, configurationParams, outputCb)
  }

  async unload () {
    await this.cancel()
    this._failAndClearActiveResponse('Model was unloaded')
    if (this.addon) {
      await this.addon.destroyInstance()
    }
    this.state.configLoaded = false
    this.state.weightsLoaded = false
  }

  async destroy () {
    await this.unload()
    this.state.destroyed = true
  }

  async _runInternal (input) {
    const response = this._job.start()
    try {
      // Per-request overrides (e.g. input.outputSampleRate) are not
      // honoured by the native engine today — all synthesis knobs are
      // resolved at construction / reload.  Route those through
      // `model.reload({...})` instead when the engine exposes them.
      const jobData = {
        type: input.type || 'text',
        input: input.input
      }

      await this.addon.runJob(jobData)
    } catch (error) {
      this._job.fail(error)
      throw error
    }

    return response
  }

  _mergeSentenceStreamStats (acc, data) {
    const t = typeof data.totalTime === 'number' ? data.totalTime : 0
    const a = typeof data.audioDurationMs === 'number' ? data.audioDurationMs : 0
    const s = typeof data.totalSamples === 'number' ? data.totalSamples : 0
    acc.totalTime += t
    acc.audioDurationMs += a
    acc.totalSamples += s
  }

  _addonOutputCallback (addon, event, data, error) {
    if (typeof error === 'string' && error.length > 0) {
      this.logger.error(`TTS job failed with error: ${error}`)
      if (this._sentenceStreamCtx && this._sentenceStreamCtx.chunkResolver) {
        const rej = this._sentenceStreamCtx.chunkResolver.reject
        this._sentenceStreamCtx.chunkResolver = null
        rej(new Error(error))
      }
      this._job.fail(error)
      return
    }

    if (data && typeof data === 'object' && data.outputArray) {
      try {
        this.logger.debug(`TTS job produced output: ${ttsOutputDebugString(data)}`)
      } catch (err) {
        if (err instanceof RangeError) {
          this.logger.debug('TTS job produced output: [data too large]')
        } else {
          throw err
        }
      }
      if (this._sentenceStreamCtx) {
        const ctx = this._sentenceStreamCtx
        const idx = ctx.chunkIdx
        const sentenceChunk = ctx.chunks[idx] || ''
        const enriched = {
          outputArray: data.outputArray,
          chunkIndex: idx,
          sentenceChunk
        }
        if (data.sampleRate != null) enriched.sampleRate = data.sampleRate
        if (!ctx.textStreamMode) {
          enriched.isLast = idx >= ctx.chunks.length - 1
        }
        this._job.output(enriched)
      } else {
        this._job.output(data)
      }
      return
    }

    if (
      data &&
      typeof data === 'object' &&
      ('totalTime' in data || 'audioDurationMs' in data || 'totalSamples' in data)
    ) {
      this.logger.info(`TTS job completed. Stats: ${JSON.stringify(data)}`)
      if (this._sentenceStreamCtx) {
        const ctx = this._sentenceStreamCtx
        this._mergeSentenceStreamStats(ctx.acc, data)
        if (ctx.chunkResolver) {
          ctx.chunkResolver.resolve()
          ctx.chunkResolver = null
        }
        if (ctx.textStreamMode) {
          return
        }
        const isLast = ctx.chunkIdx >= ctx.chunks.length - 1
        if (isLast) {
          const totalChars = ctx.chunks.join('').length
          const merged = { ...ctx.acc }
          merged.tokensPerSecond =
            ctx.acc.totalTime > 0 ? totalChars / ctx.acc.totalTime : 0
          merged.realTimeFactor =
            ctx.acc.audioDurationMs > 0
              ? (ctx.acc.totalTime * 1000.0) / ctx.acc.audioDurationMs
              : 0
          if (this.opts?.stats) {
            this._job.end(merged)
          } else {
            this._job.end()
          }
        }
        return
      }
      if (this.opts?.stats) {
        this._job.end(data)
      } else {
        this._job.end()
      }
      return
    }

    this.logger.debug(`Received TTS event: ${event}`)
  }

  async cancel () {
    if (this.addon?.cancel) {
      await this.addon.cancel()
    }
  }

  _failAndClearActiveResponse (reason) {
    if (this._sentenceStreamCtx && this._sentenceStreamCtx.chunkResolver) {
      this._sentenceStreamCtx.chunkResolver.reject(
        reason instanceof Error ? reason : new Error(String(reason))
      )
      this._sentenceStreamCtx.chunkResolver = null
    }
    this._sentenceStreamCtx = null
    this._job.fail(reason)
  }

  /**
   * Reload the addon with new configuration parameters.
   * @param {Object} newConfig
   * @param {string} [newConfig.language]
   * @param {boolean} [newConfig.useGPU]
   * @param {number} [newConfig.outputSampleRate]
   */
  async reload (newConfig = {}) {
    this.logger.debug('Reloading addon with new configuration', newConfig)

    if (newConfig.language !== undefined) this._config.language = newConfig.language
    if (newConfig.useGPU !== undefined) this._config.useGPU = newConfig.useGPU
    if (newConfig.outputSampleRate !== undefined) this._outputSampleRate = newConfig.outputSampleRate

    const ttsParams = this._buildTtsParams()

    await this.cancel()
    this._failAndClearActiveResponse('Model was reloaded')

    if (this.addon) {
      await this.addon.destroyInstance()
    }
    this.addon = this._createAddon(ttsParams, this._addonOutputCallback.bind(this))
    await this.addon.activate()
  }

  static inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static getModelKey (params) {
    return 'tts-ggml'
  }

  static ENGINE_CHATTERBOX = ENGINE_CHATTERBOX
  static ENGINE_SUPERTONIC = ENGINE_SUPERTONIC
}

module.exports = TTSGgml
module.exports.ENGINE_CHATTERBOX = ENGINE_CHATTERBOX
module.exports.ENGINE_SUPERTONIC = ENGINE_SUPERTONIC
