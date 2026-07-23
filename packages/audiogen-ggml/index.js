'use strict'

// @qvac/audiogen-ggml
//
// Audio generation (music) addon for qvac, ggml backend. Text prompt in ->
// stereo 48 kHz audio out, powered by the ACE-Step engine in audiogen-cpp
// (text-encoder + LM + DiT + VAE), compiled natively per-platform and linked
// via vcpkg — same shape as @qvac/tts-ggml.
//
// The native binding (addon/src/js-interface/binding.cpp) exposes the
// inference-addon-cpp surface: createInstance / activate / runJob / cancel /
// destroyInstance. `AudioGen` wraps it with a small async facade.

const binding = require('./binding')
const { encodePcm, pcmToWav, SUPPORTED_FORMATS } = require('./lib/audio-format')
const models = require('./models')
const { ditFilename } = models

const ENGINE_ACESTEP = 'acestep'

class AudioGen {
  /**
   * @param {Object} [options]
   * @param {string} [options.modelDir]  Directory holding the ACE-Step GGUFs.
   * @param {string} [options.textEncModel] Explicit text-encoder GGUF path.
   * @param {string} [options.lmModel]     Explicit LM GGUF path.
   * @param {string} [options.ditModel]    Explicit DiT GGUF path.
   * @param {('turbo-q4'|'turbo-q8'|'sft')} [options.ditVariant] Which DiT to use
   *   from `modelDir` when no explicit `ditModel` is given. The other three
   *   stages (text-enc, LM, VAE) are fixed; only the DiT varies. See models.js.
   * @param {string} [options.vaeModel]    Explicit VAE GGUF path.
   * @param {number} [options.inferenceSteps] Omit to let the engine auto-pick
   *   per DiT architecture (turbo 8 / sft 50).
   * @param {number} [options.shift] Omit to let the engine auto-pick per DiT
   *   architecture (turbo 3.0 / sft 1.0).
   * @param {boolean} [options.useGpu]
   * @param {number} [options.threads]
   * @param {Function} [outputCb] Native output events (pcm chunks, stats).
   */
  constructor(options = {}, outputCb = null) {
    // DiT selection: an explicit `ditModel` path always wins; otherwise a
    // `ditVariant` enum picks which DiT GGUF to load from `modelDir` (the three
    // other stages are fixed, so the variant is the only real choice).
    let ditModelPath = options.ditModel
    if (!ditModelPath && options.ditVariant) {
      if (!options.modelDir) {
        throw new Error(
          'AudioGen: `ditVariant` needs `modelDir` (the folder holding the DiT ' +
            'GGUF); otherwise pass an explicit `ditModel` path.'
        )
      }
      const dir = options.modelDir.replace(/[/\\]+$/, '')
      ditModelPath = `${dir}/${ditFilename(options.ditVariant)}`
    }

    // Flat config keys, read 1:1 by the native JSAdapter (buildAcestepConfig).
    // inferenceSteps/shift are intentionally passed through as-is (undefined =>
    // engine auto-detects turbo vs sft and picks the right schedule), so
    // selecting the `sft` DiT actually runs its 50-step pass, not turbo's 8.
    const configuration = {
      engineType: ENGINE_ACESTEP,
      modelDir: options.modelDir,
      textEncModelPath: options.textEncModel,
      lmModelPath: options.lmModel,
      ditModelPath,
      vaeModelPath: options.vaeModel,
      inferenceSteps: options.inferenceSteps,
      shift: options.shift,
      useGPU: options.useGpu,
      threads: options.threads
    }
    this._binding = binding
    this._handle = binding.createInstance(this, configuration, outputCb)
  }

  /** Finish async model load; resolves once every stage GGUF is parsed. */
  async activate() {
    return this._binding.activate(this._handle)
  }

  /**
   * Generate music from a text prompt.
   * @param {string} caption Text description of the desired music.
   * @param {Object} [opts]
   * @param {string} [opts.lyrics="[Instrumental]"]
   * @param {number} [opts.seed]
   * @param {string} [opts.vocalLanguage]
   * @param {number} [opts.bpm]        Beats per minute (0/undefined => LM infers).
   * @param {string} [opts.keyscale]   e.g. "C minor".
   * @param {string} [opts.timesignature] e.g. "4/4".
   * @param {number} [opts.duration]   Target seconds (undefined => LM decides).
   */
  async generate(caption, opts = {}) {
    return this._binding.runJob(this._handle, {
      type: 'text',
      input: caption,
      lyrics: opts.lyrics ?? '[Instrumental]',
      seed: opts.seed,
      vocalLanguage: opts.vocalLanguage,
      bpm: opts.bpm,
      keyscale: opts.keyscale,
      timesignature: opts.timesignature,
      duration: opts.duration
    })
  }

  async cancel() {
    return this._binding.cancel(this._handle)
  }

  async destroy() {
    if (this._handle === null) return
    const h = this._handle
    this._handle = null
    return this._binding.destroyInstance(h)
  }

  async unload() {
    return this.destroy()
  }

  /**
   * Encode interleaved Int16 PCM (as delivered by the output callback) into the
   * requested output format.
   * @param {Buffer|Uint8Array} pcm
   * @param {'pcm'|'wav'} [format='wav']
   * @param {Object} [opts] { sampleRate=48000, channels=2 }
   * @returns {{ data: Buffer, extension: string }}
   */
  static encode(pcm, format = 'wav', opts = {}) {
    return encodePcm(pcm, format, opts)
  }
}

module.exports = {
  AudioGen,
  ENGINE_ACESTEP,
  encodePcm,
  pcmToWav,
  OUTPUT_FORMATS: SUPPORTED_FORMATS,
  // Model manifest (registry paths, DiT-variant enum, resolvers) — the single
  // source of truth for the download layer, SDK plugin, tests and examples.
  DIT_VARIANTS: models.DIT_VARIANTS,
  DEFAULT_DIT_VARIANT: models.DEFAULT_DIT_VARIANT,
  ditVariants: models.ditVariants,
  ditFilename: models.ditFilename,
  modelFilenames: models.modelFilenames,
  modelManifest: models.modelManifest,
  modelSources: models.modelSources,
  allRegistryPaths: models.allRegistryPaths,
  REGISTRY_SOURCE: models.REGISTRY_SOURCE,
  REGISTRY_PREFIX: models.REGISTRY_PREFIX
}
