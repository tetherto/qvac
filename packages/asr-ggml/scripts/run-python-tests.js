'use strict'

const { spawnSync } = require('node:child_process')

const TEST_ARGUMENTS = ['-m', 'unittest', 'discover', '-s', 'scripts/__tests__', '-p', 'test_*.py']

function pythonCandidates(platform, configuredPython) {
  if (configuredPython) return [{ command: configuredPython, prefix: [] }]
  if (platform === 'win32') {
    return [
      { command: 'py', prefix: ['-3'] },
      { command: 'python', prefix: [] },
      { command: 'python3', prefix: [] }
    ]
  }
  return [
    { command: 'python3', prefix: [] },
    { command: 'python', prefix: [] }
  ]
}

function resolvePython(candidates, spawn) {
  for (const candidate of candidates) {
    const result = spawn(candidate.command, [...candidate.prefix, '-c', 'import sys'], {
      stdio: 'ignore'
    })
    if (!result.error && result.status === 0) return candidate
  }
  return null
}

function runPythonTests({ platform, configuredPython, spawn }) {
  const candidates = pythonCandidates(platform, configuredPython)
  const python = resolvePython(candidates, spawn)
  if (!python) throw new Error('Python 3 is required to run converter tests')
  return spawn(python.command, [...python.prefix, ...TEST_ARGUMENTS], { stdio: 'inherit' })
}

function main() {
  const result = runPythonTests({
    platform: process.platform,
    configuredPython: process.env.PYTHON,
    spawn: spawnSync
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

module.exports = { pythonCandidates, resolvePython, runPythonTests, TEST_ARGUMENTS }
