import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TranscribeSegment } from '@qvac/sdk'
import {
  formatTimedTranscription,
  isTimedTranscriptionFormat
} from '../src/serve/lib/transcription-response.js'

const SEGMENTS: TranscribeSegment[] = [
  { id: 7, startMs: 0, endMs: 1_250, text: ' Hello', append: false },
  { id: 8, startMs: 3_661_001, endMs: 3_662_250, text: ' world ', append: true }
]

describe('timed transcription response formatting', () => {
  it('recognizes only timed formats', () => {
    assert.equal(isTimedTranscriptionFormat('srt'), true)
    assert.equal(isTimedTranscriptionFormat('vtt'), true)
    assert.equal(isTimedTranscriptionFormat('verbose_json'), true)
    assert.equal(isTimedTranscriptionFormat('json'), false)
  })

  it('formats SRT with one-based cues and comma milliseconds', () => {
    const result = formatTimedTranscription('srt', SEGMENTS)
    assert.equal(result.contentType, 'text/plain; charset=utf-8')
    assert.equal(
      result.body,
      '1\n00:00:00,000 --> 00:00:01,250\nHello\n\n' + '2\n01:01:01,001 --> 01:01:02,250\nworld\n'
    )
  })

  it('formats WebVTT with a header and dot milliseconds', () => {
    const result = formatTimedTranscription('vtt', SEGMENTS)
    assert.equal(result.contentType, 'text/vtt; charset=utf-8')
    assert.equal(
      result.body,
      'WEBVTT\n\n' +
        '1\n00:00:00.000 --> 00:00:01.250\nHello\n\n' +
        '2\n01:01:01.001 --> 01:01:02.250\nworld\n'
    )
  })

  it('returns truthful partial verbose JSON', () => {
    assert.deepEqual(formatTimedTranscription('verbose_json', SEGMENTS), {
      contentType: 'application/json; charset=utf-8',
      body: {
        text: 'Hello world',
        duration: 3662.25,
        segments: [
          { id: 7, start: 0, end: 1.25, text: ' Hello' },
          { id: 8, start: 3661.001, end: 3662.25, text: ' world ' }
        ]
      }
    })
  })

  it('rounds float32 timestamp artifacts to whole milliseconds', () => {
    const segments: TranscribeSegment[] = [
      {
        id: 1,
        startMs: 9.999999776482582,
        endMs: 1230.0000190734863,
        text: ' precise',
        append: false
      }
    ]

    assert.equal(
      formatTimedTranscription('srt', segments).body,
      '1\n00:00:00,010 --> 00:00:01,230\nprecise\n'
    )
    assert.deepEqual(formatTimedTranscription('verbose_json', segments).body, {
      text: 'precise',
      duration: 1.23,
      segments: [{ id: 1, start: 0.01, end: 1.23, text: ' precise' }]
    })
  })

  it('clamps negative subtitle timestamps and preserves maximum-end duration', () => {
    const segments: TranscribeSegment[] = [
      { id: 1, startMs: -1230.4, endMs: 2_000.4, text: ' later', append: false },
      { id: 2, startMs: -0.6, endMs: 1_000.4, text: ' earlier', append: true }
    ]

    assert.equal(
      formatTimedTranscription('vtt', segments).body,
      'WEBVTT\n\n' +
        '1\n00:00:00.000 --> 00:00:01.000\nearlier\n\n' +
        '2\n00:00:00.000 --> 00:00:02.000\nlater\n'
    )
    assert.equal(
      (formatTimedTranscription('verbose_json', segments).body as { duration: number }).duration,
      2
    )
  })

  it('orders cues by start time while verbose segments keep SDK order', () => {
    const segments: TranscribeSegment[] = [
      { id: 0, startMs: 2_000, endMs: 3_000, text: ' second', append: false },
      { id: 1, startMs: 0, endMs: 1_000, text: ' first', append: true }
    ]

    assert.equal(
      formatTimedTranscription('srt', segments).body,
      '1\n00:00:00,000 --> 00:00:01,000\nfirst\n\n' + '2\n00:00:02,000 --> 00:00:03,000\nsecond\n'
    )
    assert.deepEqual(formatTimedTranscription('verbose_json', segments).body, {
      text: 'second first',
      duration: 3,
      segments: [
        { id: 0, start: 2, end: 3, text: ' second' },
        { id: 1, start: 0, end: 1, text: ' first' }
      ]
    })
  })

  it('normalizes embedded cue line breaks without changing verbose segment text', () => {
    const segments: TranscribeSegment[] = [
      {
        id: 1,
        startMs: 0,
        endMs: 1_000,
        text: '  first\r\n\r\n second\nthird  ',
        append: false
      }
    ]

    assert.equal(
      formatTimedTranscription('srt', segments).body,
      '1\n00:00:00,000 --> 00:00:01,000\nfirst second third\n'
    )
    assert.deepEqual(formatTimedTranscription('verbose_json', segments).body, {
      text: 'first\r\n\r\n second\nthird',
      duration: 1,
      segments: [{ id: 1, start: 0, end: 1, text: '  first\r\n\r\n second\nthird  ' }]
    })
  })

  it('formats empty metadata as valid empty responses', () => {
    assert.equal(formatTimedTranscription('srt', []).body, '')
    assert.equal(formatTimedTranscription('vtt', []).body, 'WEBVTT\n')
    assert.deepEqual(formatTimedTranscription('verbose_json', []).body, {
      text: '',
      duration: 0,
      segments: []
    })
  })
})
