'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { SINGLE_FILE_MANIFEST, downloadFile } = require('../download-unit-test-models')
const integrationManifest = require('../../test/integration/models.manifest.json')

test('S3-hosted C++ fixtures match their integration manifest pins', () => {
  const s3Entries = SINGLE_FILE_MANIFEST.filter((entry) => entry.s3Path)
  assert.ok(s3Entries.length > 0, 'at least one fixture is S3-hosted')
  for (const entry of s3Entries) {
    const pinned = integrationManifest.models[entry.dest]
    assert.ok(pinned, `${entry.dest} is in models.manifest.json`)
    assert.equal(entry.s3Path, pinned.s3Path, `${entry.dest} s3Path matches`)
    assert.equal(entry.sha256, pinned.sha256, `${entry.dest} sha256 matches`)
  }
})

test('an S3 fixture is skipped, not fatal, without a bucket when allowed', async () => {
  const prev = process.env.MODEL_S3_BUCKET
  delete process.env.MODEL_S3_BUCKET
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-models-'))
  const dest = path.join(dir, 'x.gguf')
  try {
    await downloadFile(undefined, dest, {
      sha256: 'a'.repeat(64),
      s3Path: 'qvac_models_compiled/x.gguf',
      skipS3WithoutBucket: true
    })
    assert.equal(fs.existsSync(dest), false)
    await assert.rejects(
      downloadFile(undefined, dest, {
        sha256: 'a'.repeat(64),
        s3Path: 'qvac_models_compiled/x.gguf'
      }),
      /MODEL_S3_BUCKET is not set/
    )
  } finally {
    if (prev !== undefined) process.env.MODEL_S3_BUCKET = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
