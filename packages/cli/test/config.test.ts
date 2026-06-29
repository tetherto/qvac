import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WHISPER_EN_TINY_Q8_0 } from '@qvac/sdk'
import { resolveExplicitServeModel, resolveModelConstant } from '../src/serve/config.js'

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
})
