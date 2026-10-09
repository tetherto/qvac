import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transcriptionsBody } from '../../../../src/serve/extensions/openai/schemas/audio'
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
