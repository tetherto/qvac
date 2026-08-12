'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { FIT_PROCESS_PROTOCOL_VERSION, resolveFitProcessRunnerPath } = require('../../process')

test('resolves the runner with Node-native absolute path semantics', () => {
  const resolved = resolveFitProcessRunnerPath()

  assert.equal(resolved, require.resolve('../../process-runner.js'))
  assert.equal(path.isAbsolute(resolved), true)
  assert.equal(path.basename(resolved), 'process-runner.js')
})

test('loads without resolving the runner so unsupported hosts can opt out first', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'model-fit-process-'))
  try {
    const isolated = path.join(scratch, 'process.js')
    fs.copyFileSync(require.resolve('../../process.js'), isolated)

    const loaded = require(isolated)

    assert.equal(loaded.FIT_PROCESS_PROTOCOL_VERSION, FIT_PROCESS_PROTOCOL_VERSION)
    assert.throws(() => loaded.resolveFitProcessRunnerPath(), { code: 'MODULE_NOT_FOUND' })
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
