import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('classification lint excludes changes made only on an advancing base branch', () => {
  const workflow = readFileSync(new URL('../../workflows/cpp-lint.yaml', import.meta.url), 'utf8')
  const script = workflow.match(/name: Resolve common ancestor for C\+\+ checks\r?\n[\s\S]*?run: \|\r?\n((?:          [^\n]*\n)+)/)?.[1]
  assert.ok(script, 'the workflow resolves the common ancestor after checkout')
  const caller = readFileSync(new URL('../../workflows/on-pr-classification-ggml.yml', import.meta.url), 'utf8')
  assert.match(caller, /use-merge-base: true/)
  const directory = mkdtempSync(join(tmpdir(), 'qvac-lint-base-'))
  function git(...args) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    return result.stdout.trim()
  }
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'CI test')
    git('config', 'user.email', 'ci@example.invalid')
    writeFileSync(join(directory, 'initial.cpp'), 'int initial;\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    const ancestor = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'feature')
    writeFileSync(join(directory, 'feature.cpp'), 'int feature;\n')
    git('add', '.')
    git('commit', '-m', 'feature')
    git('checkout', 'main')
    writeFileSync(join(directory, 'main-only.cpp'), 'int main_only;\n')
    git('add', '.')
    git('commit', '-m', 'advance main')
    git('checkout', 'feature')
    const environmentFile = join(directory, 'github-env')
    const result = spawnSync('bash', ['-e', '-c', script.replace(/^          /gm, '')], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: 'main', RUNNER_TEMP: directory, GITHUB_ENV: environmentFile },
    })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    const base = readFileSync(environmentFile, 'utf8').trim().slice('BASE_SHA='.length)
    assert.equal(base, ancestor)
    assert.equal(git('diff', '--name-only', base, 'HEAD'), 'feature.cpp')
    assert.match(git('diff', '--name-only', 'main', 'HEAD'), /main-only.cpp/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
