import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRunTests } from '../../dist/utils/test-selection.js'

const catalog = [
  { testId: 'llm-a', suites: ['smoke'], metadata: { category: 'llm' } },
  { testId: 'llm-b', metadata: { category: 'llm' } },
  {
    testId: 'ocr-a',
    suites: ['smoke'],
    metadata: { category: 'ocr' },
    skip: { reason: 'no OCR on desktop', platforms: ['desktop'] }
  },
  {
    testId: 'tts-a',
    metadata: { category: 'tts' },
    skip: { reason: 'python client lacks TTS', platforms: ['desktop-python'] }
  }
]

const ids = (selection) => selection.tests.map((t) => t.testId)

test('drops what the platform skips, after the producer-side selection', () => {
  const selection = selectRunTests(catalog, { suite: 'smoke', platform: 'desktop-macos' })
  assert.deepEqual(ids(selection), ['llm-a'])
  assert.deepEqual(selection.platformSkippedTestIds, ['ocr-a'])
  assert.equal(selection.filtered, true)
})

test('a skip for another client does not apply', () => {
  assert.deepEqual(ids(selectRunTests(catalog, { platform: 'desktop-macos' })), [
    'llm-a',
    'llm-b',
    'tts-a'
  ])
  assert.deepEqual(ids(selectRunTests(catalog, { platform: 'desktop-python' })), [
    'llm-a',
    'llm-b',
    'ocr-a'
  ])
})

test('include unions exact ids back in before the platform narrowing', () => {
  const selection = selectRunTests(catalog, {
    filter: 'llm',
    include: 'tts-a,ocr-a',
    platform: 'electron-linux'
  })
  assert.deepEqual(ids(selection), ['llm-a', 'llm-b', 'ocr-a', 'tts-a'])
  assert.deepEqual(selection.addedTestIds, ['tts-a', 'ocr-a'])
})

test('unknown include ids are reported, not dropped silently', () => {
  const selection = selectRunTests(catalog, { include: 'nope', platform: 'desktop-macos' })
  assert.deepEqual(selection.unknownTestIds, ['nope'])
})
