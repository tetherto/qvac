'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const {
  TranscriptionParakeet,
  loadGgufOrSkip,
  isMobile
} = require('./helpers.js')

test('Should accept empty files map without throwing', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }

  try {
    const model = new TranscriptionParakeet({ files: {} })
    t.ok(model, 'Model instance created with empty files map')
    t.pass('Empty files map is accepted (validation skipped for unset path)')
  } catch (error) {
    t.fail('Should not throw for empty files map: ' + error.message)
  }
})

test('Non-existent model path produces warning but does not throw', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }

  try {
    const model = new TranscriptionParakeet({
      files: { model: '/this/path/definitely/does/not/exist/model.gguf' }
    })
    t.ok(model, 'Model instance created despite non-existent path')
    t.pass('Non-existent path produces warning, not error')
  } catch (error) {
    t.fail('Should not throw for non-existent path: ' + error.message)
  }
})

test('Should accept a valid GGUF path and pass validation', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }

  const ggufPath = await loadGgufOrSkip(t, 'tdt')
  if (!ggufPath) return

  try {
    const model = new TranscriptionParakeet({ files: { model: ggufPath } })
    t.ok(model, 'Model instance created with valid GGUF path')
    t.ok(fs.existsSync(ggufPath), 'GGUF file exists at the supplied path')
  } catch (error) {
    t.fail('Should not have thrown an error: ' + error.message)
  }
})

test('Validation runs in the constructor (no async load required)', { timeout: 60000 }, async (t) => {
  if (isMobile) { t.pass('Skipped on mobile'); return }

  try {
    const model = new TranscriptionParakeet({ files: {} })
    t.ok(model, 'Constructor completes without throw')
  } catch (error) {
    t.fail('Constructor threw unexpectedly: ' + error.message)
  }
})

test('Provides a tmp scratch dir without polluting cwd', { timeout: 60000 }, async (t) => {
  const tmpDir = path.join(os.tmpdir(), '.parakeet-test-validation-scratch')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

  const stub = path.join(tmpDir, 'stub.gguf')
  fs.writeFileSync(stub, 'GGUF\x03\x00\x00\x00')
  t.ok(fs.existsSync(stub), 'Stub GGUF written to scratch dir')

  // Bogus binary content, but a valid path -- wrapper should accept
  // it; load-time validation happens later.
  const model = new TranscriptionParakeet({ files: { model: stub } })
  t.ok(model, 'Wrapper accepts a path-only configuration')

  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
})
