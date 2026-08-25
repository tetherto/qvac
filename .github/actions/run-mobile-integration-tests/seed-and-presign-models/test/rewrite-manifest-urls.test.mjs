'use strict'
import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteManifest } from '../rewrite-manifest-urls.mjs'

test('rewriteManifest prepends the presigned URL and keeps originals as fallbacks', () => {
  const manifest = {
    models: { 'sd.gguf': { urls: ['https://hf/sd.gguf'], sha256: 'a'.repeat(64), bytes: 10 } }
  }
  const rewritten = rewriteManifest(manifest, { 'sd.gguf': 'https://us/sd?sig=1' })

  assert.equal(rewritten, 1)
  assert.deepEqual(manifest.models['sd.gguf'].urls, ['https://us/sd?sig=1', 'https://hf/sd.gguf'])
  // Integrity pins must be left intact so on-device verification is unchanged.
  assert.equal(manifest.models['sd.gguf'].sha256, 'a'.repeat(64))
  assert.equal(manifest.models['sd.gguf'].bytes, 10)
})

test('rewriteManifest does not duplicate an already-present presigned URL', () => {
  const url = 'https://us/sd?sig=1'
  const manifest = { models: { 'sd.gguf': { urls: [url, 'https://hf/sd.gguf'] } } }

  rewriteManifest(manifest, { 'sd.gguf': url })

  assert.deepEqual(manifest.models['sd.gguf'].urls, [url, 'https://hf/sd.gguf'])
})

test('rewriteManifest skips models absent from the manifest', () => {
  const manifest = { models: { 'a.gguf': { urls: ['https://hf/a'] } } }

  const rewritten = rewriteManifest(manifest, { 'missing.gguf': 'https://us/missing' })

  assert.equal(rewritten, 0)
  assert.deepEqual(manifest.models['a.gguf'].urls, ['https://hf/a'])
})

test('rewriteManifest throws when the manifest has no models object', () => {
  assert.throws(() => rewriteManifest({}, {}), /no models object/)
})
