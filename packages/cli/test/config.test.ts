import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExplicitServeModel } from '../src/serve/config.js'

describe('resolveExplicitServeModel', () => {
  it('maps whispercpp-audio-translation to whispercpp-transcription and audio-translation', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {
      whisperConfig: { language: 'auto', n_threads: 4 }
    })
    assert.equal(r.sdkType, 'whispercpp-transcription')
    assert.equal(r.endpointCategory, 'audio-translation')
    assert.equal((r.config.whisperConfig as Record<string, unknown>).translate, true)
    assert.equal((r.config.whisperConfig as Record<string, unknown>).language, 'auto')
    assert.equal((r.config.whisperConfig as Record<string, unknown>).n_threads, 4)
  })

  it('creates whisperConfig.translate when whisperConfig was absent', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {})
    assert.equal((r.config.whisperConfig as Record<string, unknown>).translate, true)
  })

  it('forces translate true when operator set translate false', () => {
    const r = resolveExplicitServeModel('whispercpp-audio-translation', {
      whisperConfig: { translate: false }
    })
    assert.equal((r.config.whisperConfig as Record<string, unknown>).translate, true)
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
