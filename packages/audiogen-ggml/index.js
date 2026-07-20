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

const ENGINE_ACESTEP = 'acestep'

class AudioGen {
  /**
   * @param {Object} [options]
   * @param {string} [options.modelDir]  Directory holding the ACE-Step GGUFs.
   * @param {string} [options.textEncModel] Explicit text-encoder GGUF path.
   * @param {string} [options.lmModel]     Explicit LM GGUF path.
   * @param {string} [options.ditModel]    Explicit DiT GGUF path.
   * @param {string} [options.vaeModel]    Explicit VAE GGUF path.
   * @param {number} [options.inferenceSteps=8]
   * @param {number} [options.shift=3.0]
   * @param {boolean} [options.useGpu]
   * @param {number} [options.threads]
   * @param {Function} [outputCb] Native output events (pcm chunks, stats).
   */
  constructor (options = {}, outputCb = null) {
    // Flat config keys, read 1:1 by the native JSAdapter (buildAcestepConfig).
    const configuration = {
      engineType: ENGINE_ACESTEP,
      modelDir: options.modelDir,
      textEncModelPath: options.textEncModel,
      lmModelPath: options.lmModel,
      ditModelPath: options.ditModel,
      vaeModelPath: options.vaeModel,
      inferenceSteps: options.inferenceSteps ?? 8,
      shift: options.shift ?? 3.0,
      useGPU: options.useGpu,
      threads: options.threads
    }
    this._binding = binding
    this._handle = binding.createInstance(this, configuration, outputCb)
  }

  /** Finish async model load; resolves once every stage GGUF is parsed. */
  async activate () {
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
  async generate (caption, opts = {}) {
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

  async cancel () {
    return this._binding.cancel(this._handle)
  }

  async destroy () {
    if (this._handle == null) return
    const h = this._handle
    this._handle = null
    return this._binding.destroyInstance(h)
  }

  async unload () {
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
  static encode (pcm, format = 'wav', opts = {}) {
    return encodePcm(pcm, format, opts)
  }
}

module.exports = {
  AudioGen,
  ENGINE_ACESTEP,
  encodePcm,
  pcmToWav,
  OUTPUT_FORMATS: SUPPORTED_FORMATS
}
