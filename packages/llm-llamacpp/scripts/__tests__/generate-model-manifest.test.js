'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const generator = import('../generate-model-manifest.mjs')
const COMMIT = '0123456789012345678901234567890123456789'
const SHA256 = 'a'.repeat(64)
const MODEL_URL = `https://huggingface.co/example/model/resolve/${COMMIT}/` + 'model.gguf'
const CDN_URL = 'https://cdn.example/model.gguf?X-Amz-Credential=cdn-secret#fragment'

function canonicalHeaders() {
  return {
    'x-repo-commit': COMMIT,
    'x-linked-etag': `"${SHA256}"`,
    'x-linked-size': '1234'
  }
}

test('authHeaders sends HF_TOKEN only to the exact trusted host', async () => {
  const { authHeaders } = await generator

  assert.equal(authHeaders(MODEL_URL, 'secret').authorization, 'Bearer secret')
  assert.equal(
    authHeaders('https://huggingface.co.attacker.example/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(
    authHeaders('https://not-huggingface.co/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(
    authHeaders('https://huggingface.co@attacker.example/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(authHeaders('http://huggingface.co/model.gguf', 'secret').authorization, undefined)
})

test('redirectRequest does not forward credentials to cross-host targets', async () => {
  const { redirectRequest } = await generator

  const crossHost = redirectRequest('https://cdn.example/model.gguf', MODEL_URL, 'secret')
  assert.equal(crossHost.url, 'https://cdn.example/model.gguf')
  assert.equal(crossHost.headers.authorization, undefined)

  const sameHost = redirectRequest(`/download/${COMMIT}/model.gguf`, MODEL_URL, 'secret')
  assert.equal(sameHost.headers.authorization, 'Bearer secret')
})

test('URL display helpers redact credentials, query strings, and fragments', async () => {
  const { redactUrl, redactedErrorMessage } = await generator
  const sensitiveUrl =
    `https://username:password@huggingface.co/example/model/resolve/${COMMIT}/` +
    'model.gguf?X-Amz-Credential=query-secret#fragment-secret'
  const expected = `https://huggingface.co/example/model/resolve/${COMMIT}/model.gguf`

  assert.equal(redactUrl(sensitiveUrl), expected)
  const message = redactedErrorMessage(new Error(`request failed for ${sensitiveUrl}`))
  assert.equal(message, `request failed for ${expected}`)
  assert.doesNotMatch(message, /username|password|query-secret|fragment-secret/)
})

test('metadata errors never expose sensitive URL components', async () => {
  const { parseHuggingFaceLfsMetadata } = await generator
  const sensitiveUrl =
    `https://username:password@huggingface.co/example/model/resolve/${COMMIT}/` +
    'model.gguf?token=query-secret#fragment-secret'

  assert.throws(
    () => parseHuggingFaceLfsMetadata(sensitiveUrl, {}),
    (error) => {
      assert.match(error.message, /https:\/\/huggingface\.co\//)
      assert.doesNotMatch(error.message, /username|password|query-secret|fragment-secret/)
      return true
    }
  )
})

test('parseHuggingFaceLfsMetadata accepts complete canonical metadata', async () => {
  const { parseHuggingFaceLfsMetadata } = await generator
  const metadata = parseHuggingFaceLfsMetadata(MODEL_URL, canonicalHeaders())

  assert.deepEqual(metadata, { sha256: SHA256, bytes: 1234, repoCommit: COMMIT })
})

test('Hugging Face LFS metadata fails closed when required fields are missing', async () => {
  const { parseHuggingFaceLfsMetadata } = await generator
  const complete = canonicalHeaders()

  for (const field of Object.keys(complete)) {
    const headers = { ...complete }
    delete headers[field]
    assert.throws(
      () => parseHuggingFaceLfsMetadata(MODEL_URL, headers),
      /missing required Hugging Face LFS metadata/
    )
  }
})

test('cross-host metadata cannot fill omitted canonical metadata', async () => {
  const { metadataAfterResponse } = await generator
  const forgedHeaders = {
    'x-repo-commit': COMMIT,
    'x-linked-etag': `"${'b'.repeat(64)}"`,
    'x-linked-size': '9999'
  }

  assert.throws(
    () => metadataAfterResponse(null, MODEL_URL, {}),
    /missing required Hugging Face LFS metadata/
  )
  assert.equal(metadataAfterResponse(null, CDN_URL, forgedHeaders), null)
})

test('cross-host metadata cannot overwrite canonical metadata', async () => {
  const { metadataAfterResponse } = await generator
  const canonical = metadataAfterResponse(null, MODEL_URL, canonicalHeaders())
  const forgedHeaders = {
    'x-repo-commit': COMMIT,
    'x-linked-etag': `"${'b'.repeat(64)}"`,
    'x-linked-size': '9999'
  }

  assert.deepEqual(metadataAfterResponse(canonical, CDN_URL, forgedHeaders), canonical)
})

test('Hugging Face LFS metadata rejects repository commit mismatches', async () => {
  const { parseHuggingFaceLfsMetadata } = await generator

  assert.throws(
    () =>
      parseHuggingFaceLfsMetadata(MODEL_URL, {
        'x-repo-commit': 'f'.repeat(40),
        'x-linked-etag': `"${SHA256}"`,
        'x-linked-size': '1234'
      }),
    /repository commit mismatch/
  )
})

test('Hugging Face metadata rejects mutable resolve revisions', async () => {
  const { parseHuggingFaceLfsMetadata } = await generator
  const mutableUrl = 'https://huggingface.co/example/model/resolve/main/model.gguf'

  assert.throws(
    () =>
      parseHuggingFaceLfsMetadata(mutableUrl, {
        'x-repo-commit': COMMIT,
        'x-linked-etag': `"${SHA256}"`,
        'x-linked-size': '1234'
      }),
    /not pinned to an immutable commit/
  )
})

test('download result must match canonical Hugging Face LFS metadata', async () => {
  const { verifyDownloadAgainstLfs } = await generator
  const metadata = { sha256: SHA256, bytes: 1234, repoCommit: COMMIT }

  assert.doesNotThrow(() =>
    verifyDownloadAgainstLfs(MODEL_URL, { sha256: SHA256, bytes: 1234 }, metadata)
  )
  assert.throws(
    () => verifyDownloadAgainstLfs(MODEL_URL, { sha256: 'b'.repeat(64), bytes: 1234 }, metadata),
    /LFS SHA-256 mismatch/
  )
  assert.throws(
    () => verifyDownloadAgainstLfs(MODEL_URL, { sha256: SHA256, bytes: 1235 }, metadata),
    /LFS size mismatch/
  )
  assert.throws(
    () => verifyDownloadAgainstLfs(MODEL_URL, { sha256: SHA256, bytes: 1234 }, null),
    /missing required Hugging Face LFS metadata/
  )
})
