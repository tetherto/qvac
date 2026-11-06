import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestIds, selectTests } from '../../dist/utils/test-selection.js'

const catalog = ['a-one', 'a-two', 'b-one'].map((testId) => ({ testId, suites: [] }))

test('a file of testIds selects what the same ids in --include select', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-include-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'include.txt')
  writeFileSync(file, '  a-two\r\n\nb-one  \n\n')

  const ids = await readTestIds(file)

  assert.deepEqual(ids, ['a-two', 'b-one'])
  assert.deepEqual(
    selectTests(catalog, { filter: 'a-one', include: ids.join(',') }),
    selectTests(catalog, { filter: 'a-one', include: 'a-two,b-one' })
  )
})
