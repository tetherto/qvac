'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { pythonCandidates, runPythonTests, TEST_ARGUMENTS } = require('../run-python-tests.js')

function recordingSpawn(results) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return results[calls.length - 1]
  }
  return { calls, spawn }
}

test('Windows candidates prefer the Python launcher', () => {
  assert.deepEqual(pythonCandidates('win32'), [
    { command: 'py', prefix: ['-3'] },
    { command: 'python', prefix: [] },
    { command: 'python3', prefix: [] }
  ])
})

test('runner falls back from py to python on Windows', () => {
  const recorder = recordingSpawn([
    { error: new Error('missing'), status: null },
    { status: 0 },
    { status: 0 }
  ])

  const result = runPythonTests({
    platform: 'win32',
    configuredPython: '',
    spawn: recorder.spawn
  })

  assert.equal(result.status, 0)
  assert.deepEqual(recorder.calls[0].args, ['-3', '-c', 'import sys'])
  assert.equal(recorder.calls[1].command, 'python')
  assert.deepEqual(recorder.calls[2].args, TEST_ARGUMENTS)
})

test('runner honors a configured Python executable', () => {
  const recorder = recordingSpawn([{ status: 0 }, { status: 0 }])

  runPythonTests({
    platform: 'linux',
    configuredPython: '/opt/python',
    spawn: recorder.spawn
  })

  assert.equal(recorder.calls[0].command, '/opt/python')
  assert.equal(recorder.calls[1].command, '/opt/python')
  assert.deepEqual(recorder.calls[1].args, TEST_ARGUMENTS)
})

test('runner fails clearly when Python is unavailable', () => {
  const recorder = recordingSpawn([
    { error: new Error('missing'), status: null },
    { error: new Error('missing'), status: null }
  ])

  assert.throws(
    () =>
      runPythonTests({
        platform: 'linux',
        configuredPython: '',
        spawn: recorder.spawn
      }),
    /Python 3 is required/
  )
})
