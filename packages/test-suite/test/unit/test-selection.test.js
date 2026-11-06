import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestIds, selectRunTests, selectTests } from '../../dist/utils/test-selection.js'

const includeCatalog = ['a-one', 'a-two', 'b-one'].map((testId) => ({ testId, suites: [] }))

test('a file of testIds selects what the same ids in --include select', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-include-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'include.txt')
  writeFileSync(file, '  a-two\r\n\nb-one  \n\n')

  const ids = await readTestIds(file)

  assert.deepEqual(ids, ['a-two', 'b-one'])
  assert.deepEqual(
    selectTests(includeCatalog, { filter: 'a-one', include: ids.join(',') }),
    selectTests(includeCatalog, { filter: 'a-one', include: 'a-two,b-one' })
  )
})

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
  },
  { testId: 'llm-off', suites: ['smoke'], skip: { reason: 'disabled everywhere' } }
]

const ids = (selection) => selection.tests.map((t) => t.testId)

test('drops what the platform skips, after the producer-side selection', () => {
  const selection = selectRunTests(catalog, { suite: 'smoke', platform: 'desktop-macos' })
  assert.deepEqual(ids(selection), ['llm-a'])
  assert.deepEqual(selection.platformSkippedTestIds, ['ocr-a'])
  assert.equal(selection.filtered, true)
})

test('a test skipped on every platform is never queued, so it is not in the run', () => {
  const selection = selectRunTests(catalog, { suite: 'smoke', platform: 'desktop-macos' })
  assert.ok(!ids(selection).includes('llm-off'))
  assert.ok(!selection.platformSkippedTestIds.includes('llm-off'))
  assert.ok(
    !ids(selectRunTests(catalog, { include: 'llm-off', platform: 'desktop-macos' })).includes(
      'llm-off'
    )
  )
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
