'use strict'
import test from 'node:test'
import assert from 'node:assert/strict'

// The module reads its config from env at import time; set dummy values so the
// import succeeds without touching AWS or a real manifest. main()/run() is guarded
// behind an import.meta.url check, so importing here does not execute the seeder.
process.env.MANIFEST_PATH = '/tmp/seed-test-nonexistent-manifest.json'
process.env.S3_BUCKET = 'tether-ai-dev-us'
process.env.S3_PREFIX = 'qvac_models_compiled/ggml/'
process.env.OUTPUT_MAP = '/tmp/seed-test-url-map.json'

const { validateModelName, s3Key } = await import('../seed-and-presign.mjs')

test('validateModelName accepts a plain model filename', () => {
  assert.equal(validateModelName('model-Q4_0.gguf'), 'model-Q4_0.gguf')
})

test('validateModelName rejects traversal, separators and absolute paths', () => {
  for (const bad of ['', '.', '..', 'a/b.gguf', 'sub/dir', 'x\\y', '..\\evil', '/etc/passwd']) {
    assert.throws(() => validateModelName(bad), /invalid model name/, `should reject ${JSON.stringify(bad)}`)
  }
})

test('validateModelName rejects non-string names', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => validateModelName(bad), /invalid model name/)
  }
})

test('s3Key joins the configured prefix with the model name', () => {
  assert.equal(s3Key('model.gguf'), 'qvac_models_compiled/ggml/model.gguf')
})
