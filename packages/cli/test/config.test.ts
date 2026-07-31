import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FLUX_2_KLEIN_4B_VAE, TTS_S3GEN_EN_CHATTERBOX, WHISPER_EN_TINY_Q8_0 } from '@qvac/sdk'
import {
  parseServeConfig,
  resolveExplicitServeModel,
  resolveModelConstant
} from '../src/serve/config.js'
import { resolveNestedModelSrcConstants } from '../src/serve/resolve-nested-model-src.js'

describe('resolveExplicitServeModel', () => {
  it('maps whispercpp-audio-translation to whispercpp-transcription and audio-translation', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {
      whisperConfig: { language: 'auto', n_threads: 4 }
    })
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'audio-translation')
    assert.equal(r.config['translate'], true)
    assert.equal(r.config['language'], 'auto')
    assert.equal(r.config['n_threads'], 4)
    assert.equal('whisperConfig' in r.config, false)
  })

  it('creates translate when config was empty', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {})
    assert.equal(r.config['translate'], true)
  })

  it('forces translate true when operator set translate false (nested)', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {
      whisperConfig: { translate: false }
    })
    assert.equal(r.config['translate'], true)
    assert.equal('whisperConfig' in r.config, false)
  })

  it('forces translate true when operator set translate false (top-level)', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', { translate: false })
    assert.equal(r.config['translate'], true)
  })

  it('passes through non-virtual types unchanged', () => {
    const r = resolveExplicitServeModel('whispercpp-transcription', {
      whisperConfig: { translate: false }
    })
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'transcription')
    assert.equal((r.config.whisperConfig as Record<string, unknown>).translate, false)
  })
})

describe('resolveModelConstant', () => {
  it('resolves a constant to its registry src and natural addon', () => {
    const r = resolveModelConstant('alias', { model: 'WHISPER_EN_TINY_Q8_0' })
    assert.equal(r.modelSrc, WHISPER_EN_TINY_Q8_0)
    // The SDK constant's `addon` is the legacy `whisper` alias; the endpoint
    // category is normalized to `transcription` via ENDPOINT_CATEGORY.
    assert.equal(r.sdkType, WHISPER_EN_TINY_Q8_0.addon)
    assert.equal(r.endpointCategory, 'transcription')
  })

  it('honors a type override on a constant entry (whisper → audio-translation)', () => {
    const r = resolveModelConstant('alias', {
      model: 'WHISPER_EN_TINY_Q8_0',
      type: 'whispercpp-audio-translation',
      config: { language: 'auto' }
    })
    assert.equal(r.modelSrc, WHISPER_EN_TINY_Q8_0)
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'audio-translation')
    assert.equal(r.config['translate'], true)
    assert.equal(r.config['language'], 'auto')
    assert.equal('whisperConfig' in r.config, false)
  })

  it('throws on unknown constant names', () => {
    assert.throws(
      () => resolveModelConstant('alias', { model: 'NOT_A_REAL_CONST' }),
      /unknown model constant "NOT_A_REAL_CONST"/
    )
  })

  it('resolves nested companion *ModelSrc constant names in config', () => {
    const r = resolveModelConstant('chatterbox', {
      model: 'WHISPER_EN_TINY_Q8_0',
      type: 'tts',
      config: {
        ttsEngine: 'chatterbox',
        language: 'en',
        s3genModelSrc: 'TTS_S3GEN_EN_CHATTERBOX'
      }
    })
    assert.equal(r.config['s3genModelSrc'], TTS_S3GEN_EN_CHATTERBOX)
    assert.equal(r.config['ttsEngine'], 'chatterbox')
  })
})

describe('resolveNestedModelSrcConstants', () => {
  it('rewrites *ModelSrc constant names and leaves paths / registry URLs', () => {
    const out = resolveNestedModelSrcConstants({
      llmModelSrc: 'FLUX_2_KLEIN_4B_VAE',
      vaeModelSrc: 'registry://hf/example/vae.gguf',
      s3genModelSrc: './local/s3gen.gguf',
      steps: 20
    })
    assert.equal(out['llmModelSrc'], FLUX_2_KLEIN_4B_VAE)
    assert.equal(out['vaeModelSrc'], 'registry://hf/example/vae.gguf')
    assert.equal(out['s3genModelSrc'], './local/s3gen.gguf')
    assert.equal(out['steps'], 20)
  })

  it('rewrites nested objects and upscaler.model_src', () => {
    const out = resolveNestedModelSrcConstants({
      whisperConfig: { vadModelSrc: 'WHISPER_EN_TINY_Q8_0' },
      upscaler: { type: 'esrgan', model_src: 'TTS_S3GEN_EN_CHATTERBOX' }
    })
    const whisper = out['whisperConfig'] as Record<string, unknown>
    const upscaler = out['upscaler'] as Record<string, unknown>
    assert.equal(whisper['vadModelSrc'], WHISPER_EN_TINY_Q8_0)
    assert.equal(upscaler['model_src'], TTS_S3GEN_EN_CHATTERBOX)
  })

  it('throws on unknown CONSTANT_CASE companion names with accepted forms', () => {
    assert.throws(
      () =>
        resolveNestedModelSrcConstants(
          { s3genModelSrc: 'NOT_A_REAL_CONST' },
          'serve.models.tts.config'
        ),
      /serve\.models\.tts\.config\.s3genModelSrc: unknown model constant "NOT_A_REAL_CONST".*SDK model constant name.*registry:\/\/.*filesystem path/
    )
  })

  it('leaves bare filenames alone', () => {
    const out = resolveNestedModelSrcConstants({ s3genModelSrc: 's3gen.gguf' })
    assert.equal(out['s3genModelSrc'], 's3gen.gguf')
  })
})

describe('parseServeConfig nested companions', () => {
  it('resolves nested constants for explicit image / video entries', () => {
    const cfg = parseServeConfig(
      {
        serve: {
          models: {
            flux: {
              src: 'FLUX_2_KLEIN_4B_Q4_0',
              type: 'sdcpp-generation',
              config: {
                llmModelSrc: 'FLUX_2_KLEIN_4B_VAE',
                vaeModelSrc: 'FLUX_2_KLEIN_4B_VAE'
              }
            },
            wan: {
              src: 'placeholder',
              type: 'sdcpp-video',
              config: {
                t5XxlModelSrc: 'TTS_S3GEN_EN_CHATTERBOX'
              }
            }
          }
        }
      },
      {}
    )
    const flux = cfg.models.get('flux')!
    assert.equal(flux.config['llmModelSrc'], FLUX_2_KLEIN_4B_VAE)
    assert.equal(flux.config['vaeModelSrc'], FLUX_2_KLEIN_4B_VAE)
    const wan = cfg.models.get('wan')!
    assert.equal(wan.sdkType, 'sdcpp-generation')
    assert.equal(wan.endpointCategory, 'video')
    assert.equal(wan.config['mode'], 'video')
    assert.equal(wan.config['t5XxlModelSrc'], TTS_S3GEN_EN_CHATTERBOX)
  })

  it('leaves the ignored upscaler block unchanged for video entries', () => {
    const cfg = parseServeConfig(
      {
        serve: {
          models: {
            wan: {
              src: 'placeholder',
              type: 'sdcpp-video',
              config: {
                upscaler: {
                  type: 'esrgan',
                  model_src: 'IGNORED_VALUE'
                }
              }
            }
          }
        }
      },
      {}
    )
    const wan = cfg.models.get('wan')!
    assert.deepEqual(wan.config['upscaler'], {
      type: 'esrgan',
      model_src: 'IGNORED_VALUE'
    })
  })
})
