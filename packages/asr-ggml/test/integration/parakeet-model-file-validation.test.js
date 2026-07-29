'use strict'

// Constructor-time file validation for the parakeet engine. The unified
// package tightened the old parakeet behaviour: an empty files map and a
// non-existent GGUF path used to warn and continue, and validation was
// deferred to load(). ASRGgml now throws MODEL_REQUIRED / MODEL_NOT_FOUND
// synchronously for BOTH engines.

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const { ASRGgml, loadGgufOrSkip, isMobile } = require('./parakeet-helpers.js')

test('Empty files map throws MODEL_REQUIRED', { timeout: 60000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  try {
    // eslint-disable-next-line no-new
    new ASRGgml({ files: {}, engine: 'parakeet' })
    t.fail('Empty files map should throw')
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.MODEL_REQUIRED, 'Throws MODEL_REQUIRED (6017)')
    t.ok(error.message.includes('files.model'), 'Error message names the missing option')
  }
})

test('Non-existent model path throws MODEL_NOT_FOUND', { timeout: 60000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const missing = '/this/path/definitely/does/not/exist/model.gguf'
  try {
    // eslint-disable-next-line no-new
    new ASRGgml({ files: { model: missing }, engine: 'parakeet' })
    t.fail('Non-existent path should throw')
  } catch (error) {
    t.is(error.code, ASRGgml.ERR_CODES.MODEL_NOT_FOUND, 'Throws MODEL_NOT_FOUND (24009)')
    t.ok(error.message.includes(missing), 'Error message includes the offending path')
  }
})

test('Should accept a valid GGUF path and pass validation', { timeout: 60000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const ggufPath = await loadGgufOrSkip(t, 'tdt')
  if (!ggufPath) return

  try {
    const model = new ASRGgml({ files: { model: ggufPath }, engine: 'parakeet' })
    t.ok(model, 'Model instance created with valid GGUF path')
    t.is(model.getEngineType(), 'parakeet', 'Engine resolves to parakeet')
    t.ok(fs.existsSync(ggufPath), 'GGUF file exists at the supplied path')
  } catch (error) {
    t.fail('Should not have thrown an error: ' + error.message)
  }
})

test(
  'An unknown parakeetConfig key throws INVALID_CONFIG in the constructor',
  { timeout: 60000 },
  async (t) => {
    if (isMobile) {
      t.pass('Skipped on mobile')
      return
    }

    const ggufPath = await loadGgufOrSkip(t, 'tdt')
    if (!ggufPath) return

    try {
      // eslint-disable-next-line no-new
      new ASRGgml({
        files: { model: ggufPath },
        config: { engine: 'parakeet', parakeetConfig: { notAParakeetKey: 1 } }
      })
      t.fail('Unknown parakeetConfig key should throw')
    } catch (error) {
      t.is(error.code, ASRGgml.ERR_CODES.INVALID_CONFIG, 'Throws INVALID_CONFIG (24015)')
      t.ok(error.message.includes('notAParakeetKey'), 'Error message names the rejected config key')
    }
  }
)

test('Provides a tmp scratch dir without polluting cwd', { timeout: 60000 }, async (t) => {
  const tmpDir = path.join(os.tmpdir(), '.parakeet-test-validation-scratch')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

  const stub = path.join(tmpDir, 'stub.gguf')
  fs.writeFileSync(stub, 'GGUF\x03\x00\x00\x00')
  t.ok(fs.existsSync(stub), 'Stub GGUF written to scratch dir')

  // Bogus binary content, but the path exists and the GGUF magic sniffs to the
  // parakeet engine -- the constructor accepts it; the real GGUF parse happens
  // at load().
  const model = new ASRGgml({ files: { model: stub } })
  t.ok(model, 'Wrapper accepts a path-only configuration')
  t.is(model.getEngineType(), 'parakeet', 'GGUF magic bytes sniff to the parakeet engine')

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (e) {
    /* ignore */
  }
})
