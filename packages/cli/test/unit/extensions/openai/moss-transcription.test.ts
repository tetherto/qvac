import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  transcriptionsBody,
  assertTranscriptionOptionsSupported
} from '../../../../src/serve/extensions/openai/schemas/audio'
import { normalizeEndpointCategory } from '../../../../src/serve/core/config/endpoint-category'
import { formatTimedTranscription } from '../../../../src/serve/lib/transcription-response'

test('MOSS multipart options preserve empty hotwords and the default token limit', () => {
  const body = transcriptionsBody.parse({
    model: 'moss',
    file: Buffer.alloc(0),
    hotwords: '[]',
    max_new_tokens: '0'
  })
  assert.deepEqual(body.hotwords, [])
  assert.equal(body.max_new_tokens, 0)
  assert.equal(normalizeEndpointCategory('moss-transcribe'), 'transcription')
})

test('MOSS multipart options reject malformed or oversized hotwords', () => {
  for (const hotwords of [
    'invalid',
    '[""]',
    JSON.stringify(['é'.repeat(33)]),
    JSON.stringify(Array(65).fill('name'))
  ]) {
    assert.equal(
      transcriptionsBody.safeParse({ model: 'moss', file: Buffer.alloc(0), hotwords }).success,
      false
    )
  }
})

test('MOSS verbose responses preserve speaker labels and timestamps', () => {
  const response = formatTimedTranscription('verbose_json', [
    { id: 0, startMs: 100, endMs: 900, text: 'Hello', append: false, speakerId: 0, speaker: 'S01' }
  ])
  assert.deepEqual(response.body, {
    text: 'Hello',
    duration: 0.9,
    segments: [{ id: 0, start: 0.1, end: 0.9, text: 'Hello', speaker_id: 0, speaker: 'S01' }]
  })
})

test('MOSS accepts a prompt with empty hotwords, matching fit assessment', () => {
  const body = transcriptionsBody.parse({
    model: 'moss',
    file: Buffer.alloc(0),
    prompt: 'Transcribe.',
    hotwords: '[]'
  })
  assert.doesNotThrow(() => assertTranscriptionOptionsSupported(body, 'moss-transcribe'))
})

test('MOSS rejects a prompt with non-empty hotwords', () => {
  for (const prompt of ['', 'Transcribe.']) {
    assert.throws(
      () => assertTranscriptionOptionsSupported({ prompt, hotwords: ['QVAC'] }, 'moss-transcribe'),
      { status: 400, code: 'invalid_parameter' }
    )
  }
})

test('non-MOSS transcription rejects MOSS-only options, including empty and zero values', () => {
  for (const modelType of ['whispercpp-transcription', 'parakeet-transcription']) {
    for (const body of [{ hotwords: [] }, { max_new_tokens: 0 }]) {
      assert.throws(() => assertTranscriptionOptionsSupported(body, modelType), {
        status: 400,
        code: 'unsupported_parameter'
      })
    }
  }
})
