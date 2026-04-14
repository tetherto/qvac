'use strict'

const { platform } = require('bare-os')
const path = require('bare-path')
const QvacLogger = require('@qvac/logging')
const {
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition: inferGetApiDefinition
} = require('@qvac/infer-base')
const { TTSInterface } = require('./tts')
const { QvacErrorAddonTTS, ERR_CODES } = require('./lib/error')
const { splitTtsText } = require('./lib/textChunker')

// Engine types
const ENGINE_CHATTERBOX = 'chatterbox'
const ENGINE_SUPERTONIC = 'supertonic'

function firstNonEmpty (...candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i]
    if (v != null && v !== '') return v
  }
  return undefined
}

/**
 * Whether `n` has at least one non-empty explicit artifact path (tokenizer, encoders,
 * vocoder, config, etc.). Used with `modelDir` to tell Chatterbox vs Supertonic layouts apart.
 * @param {Record<string, unknown>} n Normalized files map (same shape as {@link normalizeOnnxTtsFiles} output).
 */
function hasAnyExplicitArtifact (n) {
  const keys = [
    'tokenizer', 'speechEncoder', 'embedTokens', 'conditionalDecoder', 'languageModel',
    'textEncoder', 'durationPredictor', 'vectorEstimator', 'vocoder',
    'unicodeIndexer', 'ttsConfig', 'voiceStyle'
  ]
  for (let i = 0; i < keys.length; i++) {
    const v = n[keys[i]]
    if (v != null && v !== '') return true
  }
  return false
}

/**
 * @param {{ engine?: string }} options
 * @param {Record<string, string | undefined>} normalizedFiles
 */
function resolveEngineType (options, normalizedFiles) {
  const e = options.engine
  if (e != null && e !== '') {
    if (e === ENGINE_CHATTERBOX || e === ENGINE_SUPERTONIC) return e
    throw new Error(
      `ONNXTTS: invalid engine "${e}"; use "${ENGINE_CHATTERBOX}" or "${ENGINE_SUPERTONIC}"`
    )
  }

  const modelDirSet =
    normalizedFiles.modelDir != null && normalizedFiles.modelDir !== ''
  if (modelDirSet && !hasAnyExplicitArtifact(normalizedFiles)) {
    return ENGINE_SUPERTONIC
  }

  if (
    (normalizedFiles.textEncoder != null && normalizedFiles.textEncoder !== '') ||
    (normalizedFiles.durationPredictor != null && normalizedFiles.durationPredictor !== '')
  ) {
    return ENGINE_SUPERTONIC
  }

  return ENGINE_CHATTERBOX
}

function ttsOutputDebugString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

function normalizeOnnxTtsFiles (files) {
  if (files == null || typeof files !== 'object') {
    return {}
  }
  const f = files
  return {
    modelDir: firstNonEmpty(f.modelDir),
    tokenizer: firstNonEmpty(f.tokenizer, f.tokenizerPath),
    speechEncoder: firstNonEmpty(f.speechEncoder, f.speechEncoderPath),
    embedTokens: firstNonEmpty(f.embedTokens, f.embedTokensPath),
    conditionalDecoder: firstNonEmpty(f.conditionalDecoder, f.conditionalDecoderPath),
    languageModel: firstNonEmpty(f.languageModel, f.languageModelPath),
    textEncoder: firstNonEmpty(f.textEncoder, f.textEncoderPath, f.supertonicModel),
    durationPredictor: firstNonEmpty(
      f.durationPredictor,
      f.durationPredictorPath,
      f.latentDenoiser,
      f.latentDenoiserPath
    ),
    vectorEstimator: firstNonEmpty(f.vectorEstimator, f.vectorEstimatorPath),
    vocoder: firstNonEmpty(
      f.vocoder,
      f.vocoderPath,
      f.voiceDecoder,
      f.voiceDecoderPath,
      f.supertonicVocoder
    ),
    unicodeIndexer: firstNonEmpty(f.unicodeIndexer, f.unicodeIndexerPath),
    ttsConfig: firstNonEmpty(f.ttsConfig, f.ttsConfigPath),
    voiceStyle: firstNonEmpty(f.voiceStyle, f.voiceStyleJsonPath),
    voicesDir: firstNonEmpty(f.voicesDir)
  }
}

class ONNXTTS {
  constructor (options = {}) {
    const {
      files: filesInput = {},
      config = {},
      engine,
      logger,
      lazySessionLoading,
      referenceAudio,
      voiceName,
      speed,
      numInferenceSteps,
      supertonicMultilingual,
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
    /** Serializes `runStream` until each response settles (Whisper-style). */
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

    const normalizedFiles = normalizeOnnxTtsFiles(filesInput)

    this._engineType = resolveEngineType({ engine }, normalizedFiles)

    if (
      this._engineType === ENGINE_SUPERTONIC &&
      !normalizedFiles.modelDir &&
      normalizedFiles.textEncoder &&
      !normalizedFiles.vectorEstimator
    ) {
      normalizedFiles.vectorEstimator = path.join(
        path.dirname(normalizedFiles.textEncoder),
        'vector_estimator.onnx'
      )
    }

    this._config = { ...config }

    this._lazySessionLoading = lazySessionLoading != null
      ? lazySessionLoading
      : (platform() === 'ios' || platform() === 'android')

    if (this._engineType === ENGINE_CHATTERBOX) {
      const root = normalizedFiles.modelDir
      if (root) {
        this._tokenizerPath = firstNonEmpty(
          normalizedFiles.tokenizer,
          path.join(root, 'tokenizer.json')
        )
        this._speechEncoderPath = firstNonEmpty(
          normalizedFiles.speechEncoder,
          path.join(root, 'speech_encoder.onnx')
        )
        this._embedTokensPath = firstNonEmpty(
          normalizedFiles.embedTokens,
          path.join(root, 'embed_tokens.onnx')
        )
        this._conditionalDecoderPath = firstNonEmpty(
          normalizedFiles.conditionalDecoder,
          path.join(root, 'conditional_decoder.onnx')
        )
        this._languageModelPath = firstNonEmpty(
          normalizedFiles.languageModel,
          path.join(root, 'language_model.onnx')
        )
      } else {
        this._tokenizerPath = normalizedFiles.tokenizer
        this._speechEncoderPath = normalizedFiles.speechEncoder
        this._embedTokensPath = normalizedFiles.embedTokens
        this._conditionalDecoderPath = normalizedFiles.conditionalDecoder
        this._languageModelPath = normalizedFiles.languageModel
      }
      this._referenceAudio = referenceAudio
    } else {
      this._modelDir = normalizedFiles.modelDir
      this._voiceName = voiceName ?? 'F1'
      this._speed = speed != null ? speed : 1
      this._numInferenceSteps = numInferenceSteps != null ? numInferenceSteps : 5
      this._supertonicMultilingual = supertonicMultilingual !== false
      if (normalizedFiles.modelDir) {
        const onnx = path.join(normalizedFiles.modelDir, 'onnx')
        this._textEncoderPath = firstNonEmpty(
          normalizedFiles.textEncoder,
          path.join(onnx, 'text_encoder.onnx')
        )
        this._durationPredictorPath = firstNonEmpty(
          normalizedFiles.durationPredictor,
          path.join(onnx, 'duration_predictor.onnx')
        )
        this._vectorEstimatorPath = firstNonEmpty(
          normalizedFiles.vectorEstimator,
          path.join(onnx, 'vector_estimator.onnx')
        )
        this._vocoderPath = firstNonEmpty(
          normalizedFiles.vocoder,
          path.join(onnx, 'vocoder.onnx')
        )
        this._unicodeIndexerPath = firstNonEmpty(
          normalizedFiles.unicodeIndexer,
          path.join(onnx, 'unicode_indexer.json')
        )
        this._ttsConfigPath = firstNonEmpty(
          normalizedFiles.ttsConfig,
          path.join(onnx, 'tts.json')
        )
        const voiceStylesRoot = firstNonEmpty(
          normalizedFiles.voicesDir,
          path.join(normalizedFiles.modelDir, 'voice_styles')
        )
        this._voiceStyleJsonPath = firstNonEmpty(
          normalizedFiles.voiceStyle,
          path.join(
            voiceStylesRoot,
            `${this._voiceName.replace(/\.json$/i, '')}.json`
          )
        )
      } else {
        this._textEncoderPath = normalizedFiles.textEncoder
        this._durationPredictorPath = normalizedFiles.durationPredictor
        this._vectorEstimatorPath = normalizedFiles.vectorEstimator
        this._vocoderPath = normalizedFiles.vocoder
        this._unicodeIndexerPath = firstNonEmpty(
          normalizedFiles.unicodeIndexer,
          normalizedFiles.tokenizer
        )
        this._ttsConfigPath = normalizedFiles.ttsConfig
        this._voiceStyleJsonPath = firstNonEmpty(
          normalizedFiles.voiceStyle,
          normalizedFiles.voicesDir
            ? path.join(
              normalizedFiles.voicesDir,
              `${this._voiceName.replace(/\.json$/i, '')}.json`
            )
            : undefined
        )
      }
    }
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
      throw new QvacErrorAddonTTS({
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

  async run (input) {
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
   * Chunk long text by sentence (see {@link splitTtsText}), synthesize each chunk in order,
   * and emit PCM on `response.onUpdate` as each chunk completes.
   *
   * @param {string} text
   * @param {{ locale?: string, maxChunkScalars?: number }} [options]
   */
  async runStream (text, options = {}) {
    const opts = options == null || typeof options !== 'object' ? {} : options
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: 'runStream: non-empty string required'
      })
    }
    if (this.exclusiveRun) {
      return await this._enqueueExclusiveTtsResponse(() =>
        this._runStreamOrchestrator(text, opts)
      )
    }
    return this._runStreamOrchestrator(text, opts)
  }

  /**
   * Starts a {@link QvacResponse} and schedules chunk synthesis without awaiting completion
   * (so callers can attach `onUpdate` before audio callbacks run).
   */
  _runStreamOrchestrator (text, options) {
    const chunks = splitTtsText(String(text), {
      language: this._config?.language,
      locale: options.locale,
      maxScalars: options.maxChunkScalars
    })
    if (chunks.length === 0) {
      throw new QvacErrorAddonTTS({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: 'runStream: text produced no chunks after split'
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
    if (!ctx) return
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
    this.logger.info('[TTS] Engine type:', this._engineType)
    this.logger.info('[TTS] Language:', this._config?.language || 'en')

    let ttsParams
    if (this._engineType === ENGINE_SUPERTONIC) {
      ttsParams = this._getSupertonicTtsParams()
    } else {
      ttsParams = {
        tokenizerPath: this._tokenizerPath || '',
        speechEncoderPath: this._speechEncoderPath || '',
        embedTokensPath: this._embedTokensPath || '',
        conditionalDecoderPath: this._conditionalDecoderPath || '',
        languageModelPath: this._languageModelPath || '',
        language: this._config?.language || 'en',
        useGPU: this._config?.useGPU || false,
        lazySessionLoading: this._lazySessionLoading
      }
      if (this._referenceAudio != null) {
        ttsParams.referenceAudio = this._referenceAudio
      }
    }

    this.addon = this._createAddon(ttsParams, this._addonOutputCallback.bind(this))
    await this.addon.activate()
  }

  _getSupertonicTtsParams () {
    const baseDir = this._modelDir || ''
    return {
      modelDir: baseDir,
      textEncoderPath: this._textEncoderPath || '',
      durationPredictorPath: this._durationPredictorPath || '',
      vectorEstimatorPath: this._vectorEstimatorPath || '',
      vocoderPath: this._vocoderPath || '',
      unicodeIndexerPath: this._unicodeIndexerPath || '',
      ttsConfigPath: this._ttsConfigPath || '',
      voiceStyleJsonPath: this._voiceStyleJsonPath || '',
      voiceName: this._voiceName || 'F1',
      language: this._config?.language || 'en',
      speed: String(this._speed),
      numInferenceSteps: String(this._numInferenceSteps),
      supertonicMultilingual: this._supertonicMultilingual
    }
  }

  /**
   * Instantiate the native addon with the given parameters.
   * @param {Object} configurationParams - Configuration parameters for the addon
   * @param {Function} outputCb - Callback for inference events
   * @returns {TTSInterface} The instantiated addon interface
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

  /**
   * Tear down the native addon and mark this instance destroyed (see {@link ONNXTTS#getState}).
   * @returns {Promise<void>}
   */
  async destroy () {
    await this.unload()
    this.state.destroyed = true
  }

  async _runInternal (input) {
    const response = this._job.start()
    try {
      await this.addon.runJob({
        type: input.type || 'text',
        input: input.input
      })
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
        this._job.output({
          outputArray: data.outputArray,
          chunkIndex: idx,
          sentenceChunk
        })
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
        const isLast = ctx.chunkIdx >= ctx.chunks.length - 1
        if (ctx.chunkResolver) {
          ctx.chunkResolver.resolve()
          ctx.chunkResolver = null
        }
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
   * Supports changing both runtime parameters (language, useGPU) and model files.
   * @param {Object} newConfig - New configuration parameters
   * @param {string} [newConfig.language] - Language setting (defaults to 'en')
   * @param {boolean} [newConfig.useGPU] - Whether to use GPU (defaults to false)
   */
  async reload (newConfig = {}) {
    this.logger.debug('Reloading addon with new configuration', newConfig)

    if (newConfig.language !== undefined) {
      this._config.language = newConfig.language
    }
    if (newConfig.useGPU !== undefined) {
      this._config.useGPU = newConfig.useGPU
    }

    let ttsParams
    if (this._engineType === ENGINE_SUPERTONIC) {
      ttsParams = this._getSupertonicTtsParams()
    } else {
      ttsParams = {
        tokenizerPath: this._tokenizerPath || '',
        speechEncoderPath: this._speechEncoderPath || '',
        embedTokensPath: this._embedTokensPath || '',
        conditionalDecoderPath: this._conditionalDecoderPath || '',
        languageModelPath: this._languageModelPath || '',
        language: this._config?.language || 'en',
        useGPU: this._config?.useGPU || false,
        lazySessionLoading: this._lazySessionLoading
      }
      if (this._referenceAudio != null) {
        ttsParams.referenceAudio = this._referenceAudio
      }
    }

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
    return 'onnx-tts'
  }
}

module.exports = ONNXTTS
