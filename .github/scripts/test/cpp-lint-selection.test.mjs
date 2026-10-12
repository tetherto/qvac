import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectCppLintRows } from '../../actions/nx-project-matrix/cpp-lint-selection.mjs'

const SPEECH_PACKAGES = ['asr-ggml', 'tts-ggml', 'audiogen-ggml', 'bci-whispercpp']
const rows = SPEECH_PACKAGES.map((name) => ({
  package: name, workdir: `packages/${name}`, hasCppLint: true,
}))

test('speech dependency and JS changes do not require cpp-lint', () => {
  const files = rows.flatMap((row) => [
    `${row.workdir}/vcpkg.json`, `${row.workdir}/vcpkg-configuration.json`,
    `${row.workdir}/package.json`, `${row.workdir}/index.js`, `${row.workdir}/README.md`,
  ])
  assert.deepEqual(selectCppLintRows(rows, files), [])
})

test('each C/C++ source and header extension selects only its package', () => {
  for (const row of rows) {
    for (const extension of ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx']) {
      assert.deepEqual(selectCppLintRows(rows, [`${row.workdir}/addon/src/file.${extension}`]), [row])
    }
  }
})

test('deleted files and both sides of a rename select their owners', () => {
  assert.deepEqual(selectCppLintRows(rows, [
    'packages/asr-ggml/addon/src/deleted.cpp',
    'packages/tts-ggml/addon/src/previous.hpp',
    'packages/bci-whispercpp/addon/src/renamed.hpp',
  ]), [rows[0], rows[1], rows[3]])
})

test('dispatch keeps cpp-lint and non-speech selection remains unchanged', () => {
  const other = { package: 'llm-llamacpp', workdir: 'packages/llm-llamacpp', hasCppLint: true }
  const disabled = { ...rows[0], hasCppLint: false }
  assert.deepEqual(selectCppLintRows([...rows, disabled], null), rows)
  assert.deepEqual(selectCppLintRows([...rows, other, disabled], []), [other])
  assert.deepEqual(selectCppLintRows(rows, ['packages/asr-ggml-other/file.cpp']), [])
})

test('PR workflow filters cpp-lint with API paths and accepts a skipped job for merge', () => {
  const workflow = readFileSync(new URL('../../workflows/on-pr-nx.yml', import.meta.url), 'utf8')
  assert.match(workflow, /CHANGED_FILES: \$\{\{ runner.temp \}\}\/nx-changed-files.raw/)
  assert.match(workflow, /node .github\/actions\/nx-project-matrix\/cpp-lint-selection.mjs >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /needs.cpp-lint.result == 'success' \|\| needs.cpp-lint.result == 'skipped'/)
})
