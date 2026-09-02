import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { run } from '../check-prebuild-size.mjs'
import { BYTES_PER_MB } from '../measure-prebuilds.mjs'

function makeTree (bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuild-gate-'))
  fs.mkdirSync(path.join(root, 'linux-x64'), { recursive: true })
  fs.writeFileSync(path.join(root, 'linux-x64/cuda.so'), Buffer.alloc(bytes))
  return root
}

function withExitCode (fn) {
  const previous = process.exitCode
  process.exitCode = 0
  try {
    fn()
    return process.exitCode
  } finally {
    process.exitCode = previous
  }
}

test('run passes when the tree is under the limit', () => {
  const dir = makeTree(BYTES_PER_MB)

  const code = withExitCode(() => {
    const measurement = run({ PREBUILD_DIR: dir, MAX_TOTAL_MB: '10' })
    assert.equal(measurement.bytes, BYTES_PER_MB)
  })

  assert.equal(code, 0)
})

test('run fails the job when the tree exceeds the limit', () => {
  const dir = makeTree(3 * BYTES_PER_MB)

  const code = withExitCode(() => {
    run({ PREBUILD_DIR: dir, MAX_TOTAL_MB: '2' })
  })

  assert.equal(code, 1)
})

test('run reports without failing when no limit is set', () => {
  const dir = makeTree(50 * BYTES_PER_MB)

  const code = withExitCode(() => {
    run({ PREBUILD_DIR: dir, MAX_TOTAL_MB: '' })
  })

  assert.equal(code, 0)
})

test('run appends its report to the step summary when one is configured', () => {
  const dir = makeTree(BYTES_PER_MB)
  const summary = path.join(dir, 'summary.md')

  withExitCode(() => {
    run({ PREBUILD_DIR: dir, MAX_TOTAL_MB: '10', GITHUB_STEP_SUMMARY: summary })
  })

  assert.match(fs.readFileSync(summary, 'utf8'), /## Prebuild size/)
})

test('run rejects a missing directory', () => {
  assert.throws(
    () => run({ PREBUILD_DIR: path.join(os.tmpdir(), 'definitely-absent-prebuilds') }),
    /does not exist/
  )
})

test('run requires a directory', () => {
  assert.throws(() => run({}), /PREBUILD_DIR is required/)
})
