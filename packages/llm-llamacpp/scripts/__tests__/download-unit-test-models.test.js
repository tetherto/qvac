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
      s3Optional: true
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

test('a failed S3 copy is skipped when optional and fatal otherwise', async () => {
  const prev = { bucket: process.env.MODEL_S3_BUCKET, path: process.env.PATH }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-models-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'aws'), '#!/bin/sh\nexit 255\n', { mode: 0o755 })
  process.env.MODEL_S3_BUCKET = 'bucket'
  process.env.PATH = `${bin}${path.delimiter}${prev.path}`
  const dest = path.join(dir, 'x.gguf')
  const opts = { sha256: 'a'.repeat(64), s3Path: 'qvac_models_compiled/x.gguf' }
  try {
    await downloadFile(undefined, dest, { ...opts, s3Optional: true })
    assert.equal(fs.existsSync(dest), false)
  } finally {
    if (prev.bucket === undefined) delete process.env.MODEL_S3_BUCKET
    else process.env.MODEL_S3_BUCKET = prev.bucket
    process.env.PATH = prev.path
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isS3Only treats an empty urls array as S3-only', () => {
  const { isS3Only } = require('../model-source')
  assert.equal(isS3Only({ s3Path: 'x/m.gguf' }), true)
  assert.equal(isS3Only({ urls: [], s3Path: 'x/m.gguf' }), true)
  assert.equal(isS3Only({ urls: ['https://huggingface.co/a'], s3Path: 'x/m.gguf' }), false)
  assert.equal(isS3Only({ urls: [] }), false)
  assert.equal(isS3Only(undefined), false)
})
