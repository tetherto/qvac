import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExplicitServeModel, resolveModelConstant } from '../src/serve/config.js'

const WHISPER_CONST = {
  src: 'registry://whisper-en-tiny-q8_0',
  addon: 'whispercpp-transcription',
  name: 'WHISPER_EN_TINY_Q8_0'
}
const LLM_CONST = {
  src: 'registry://qwen3-600m-inst-q4',
  addon: 'llamacpp-completion',
  name: 'QWEN3_600M_INST_Q4'
}

function makeRegistry () {
  const m = new Map<string, typeof WHISPER_CONST>()
  m.set('WHISPER_EN_TINY_Q8_0', WHISPER_CONST)
  m.set('QWEN3_600M_INST_Q4', LLM_CONST)
  return m
}

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
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {
      translate: false
    })
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
    const r = resolveModelConstant('alias', 'WHISPER_EN_TINY_Q8_0', makeRegistry())
    assert.equal(r.src, WHISPER_CONST.src)
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'transcription')
  })

  it('honors a type override on a constant entry (whisper → audio-translation)', () => {
    const r = resolveModelConstant('alias', 'WHISPER_EN_TINY_Q8_0', makeRegistry(), {
      model: 'WHISPER_EN_TINY_Q8_0',
      type: 'whispercpp-audio-translation',
      config: { language: 'auto' }
    })
    assert.equal(r.src, WHISPER_CONST.src)
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'audio-translation')
    assert.equal(r.config['translate'], true)
    assert.equal(r.config['language'], 'auto')
    assert.equal('whisperConfig' in r.config, false)
  })

  it('throws on unknown constant names', () => {
    assert.throws(
      () => resolveModelConstant('alias', 'NOT_A_REAL_CONST', makeRegistry()),
      /unknown model constant "NOT_A_REAL_CONST"/
    )
  })
})
