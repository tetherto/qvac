import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  checkEntry,
  checkManifest,
  fetchHeaders,
  isHuggingFaceLfsUrl,
  linkedIntegrity
} from '../check-manifest-availability.mjs'

const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const HF_URL = `https://huggingface.co/org/repo/resolve/${'0'.repeat(40)}/model.gguf`

function pinnedEntry(extra = {}) {
  return { group: 'base', urls: [HF_URL], sha256: SHA, bytes: 1234, ...extra }
}

// A fake header fetch: maps url -> { statusCode, headers }.
function fakeFetch(map) {
  return async (url) => {
    if (!(url in map)) throw new Error(`missing fixture for ${url}`)
    if (map[url] instanceof Error) throw map[url]
    return map[url]
  }
}

function linkedHeaders(sha, bytes) {
  return { 'x-linked-etag': `"${sha}"`, 'x-linked-size': String(bytes) }
}

test('isHuggingFaceLfsUrl only matches https huggingface.co /resolve/ URLs', () => {
  assert.equal(isHuggingFaceLfsUrl(HF_URL), true)
  assert.equal(isHuggingFaceLfsUrl('https://huggingface.co/org/repo/blob/main/x'), false)
  assert.equal(isHuggingFaceLfsUrl('https://huggingface.co.evil.test/x/resolve/y/z'), false)
  assert.equal(isHuggingFaceLfsUrl('http://huggingface.co/org/repo/resolve/rev/x'), false)
  assert.equal(isHuggingFaceLfsUrl('not a url'), false)
})

test('linkedIntegrity parses weak/quoted etag and positive size only', () => {
  assert.deepEqual(linkedIntegrity({ 'x-linked-etag': `W/"${SHA}"`, 'x-linked-size': '10' }), {
    sha256: SHA,
    bytes: 10
  })
  assert.deepEqual(linkedIntegrity({ 'x-linked-etag': 'not-a-sha', 'x-linked-size': '0' }), {
    sha256: undefined,
    bytes: undefined
  })
})

test('checkEntry: ok when upstream content address matches the pin', async () => {
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 302, headers: linkedHeaders(SHA, 1234) } })
  assert.deepEqual(await checkEntry('m', pinnedEntry(), { fetch }), { status: 'ok', reason: '' })
})

test('checkEntry: drift when upstream sha256 differs', async () => {
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 302, headers: linkedHeaders(OTHER_SHA, 1234) } })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'drift')
  assert.match(r.reason, /sha256/)
})

test('checkEntry: drift when upstream size differs', async () => {
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 302, headers: linkedHeaders(SHA, 9999) } })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'drift')
  assert.match(r.reason, /bytes/)
})

test('checkEntry: drift when the entry is not fully pinned', async () => {
  const fetch = fakeFetch({})
  const r = await checkEntry('m', pinnedEntry({ sha256: null }), { fetch })
  assert.equal(r.status, 'drift')
  assert.match(r.reason, /not fully pinned/)
})

test('checkEntry: inaccessible on a 404', async () => {
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 404, headers: {} } })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'inaccessible')
  assert.match(r.reason, /HTTP 404/)
})

test('checkEntry: skipped when the redirect carries no canonical metadata', async () => {
  // A 3xx means the object resolved (reachable) but exposes no linked content
  // address (e.g. a redirected non-LFS sidecar or an xet-backed object). It is
  // reachable-but-unfingerprintable, so it is skipped rather than failed.
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 302, headers: {} } })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'skipped')
  assert.match(r.reason, /without linked content address/)
})

test('checkEntry: skipped when there is no HF LFS source', async () => {
  const fetch = fakeFetch({})
  const r = await checkEntry('m', pinnedEntry({ urls: ['https://s3.example/model.gguf'] }), { fetch })
  assert.equal(r.status, 'skipped')
})

test('checkEntry: skipped on a non-LFS 200 response', async () => {
  const fetch = fakeFetch({ [HF_URL]: { statusCode: 200, headers: {} } })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'skipped')
})

test('checkEntry: transport error is reported as inaccessible and redacted', async () => {
  const signed = 'https://user:pw@cdn.example/model.gguf?X-Amz-Credential=secret'
  const fetch = fakeFetch({ [HF_URL]: new Error(`boom ${signed}`) })
  const r = await checkEntry('m', pinnedEntry(), { fetch })
  assert.equal(r.status, 'inaccessible')
  assert.doesNotMatch(r.reason, /user|pw|X-Amz|secret/)
  assert.match(r.reason, /cdn\.example\/model\.gguf/)
})

async function withManifest(manifest, run) {
  const root = await mkdtemp(join(tmpdir(), 'qvac-check-manifest-test-'))
  const dir = join(root, 'packages/example/test/integration')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'models.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('checkManifest: aggregates results and fails on any drift/inaccessible', async () => {
  const badUrl = `https://huggingface.co/org/repo/resolve/${'0'.repeat(40)}/bad.gguf`
  const manifest = {
    models: {
      'good.gguf': { group: 'base', urls: [HF_URL], sha256: SHA, bytes: 1234 },
      'bad.gguf': { group: 'base', urls: [badUrl], sha256: SHA, bytes: 1234 }
    }
  }
  await withManifest(manifest, async (root) => {
    const fetch = fakeFetch({
      [HF_URL]: { statusCode: 302, headers: linkedHeaders(SHA, 1234) },
      [badUrl]: { statusCode: 302, headers: linkedHeaders(OTHER_SHA, 1234) }
    })
    const { failures, ok } = await checkManifest({ package: 'example', root }, { fetch })
    assert.equal(ok, 1)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].name, 'bad.gguf')
  })
})

test('checkManifest: --group filters the entries that are checked', async () => {
  const otherUrl = `https://huggingface.co/org/repo/resolve/${'0'.repeat(40)}/other.gguf`
  const manifest = {
    models: {
      'base.gguf': { group: 'base', urls: [HF_URL], sha256: SHA, bytes: 1234 },
      'wan.gguf': { group: 'wan22', urls: [otherUrl], sha256: SHA, bytes: 1234 }
    }
  }
  await withManifest(manifest, async (root) => {
    let requested = 0
    const fetch = async (url) => {
      requested++
      assert.equal(url, otherUrl)
      return { statusCode: 302, headers: linkedHeaders(SHA, 1234) }
    }
    const { ok } = await checkManifest({ package: 'example', root, group: 'wan22' }, { fetch })
    assert.equal(ok, 1)
    assert.equal(requested, 1)
  })
})

test('fetchHeaders: never follows the redirect and discards the body', async () => {
  const signed = 'https://cdn.example/model.gguf?X-Amz-Signature=secret'
  const requester = {
    get(url, _options, callback) {
      // Requesting the signed CDN target would be a token-replay bug.
      if (url !== HF_URL) throw new Error(`must not request ${url}`)
      const response = Readable.from(['redirect page body'])
      response.statusCode = 302
      response.headers = { location: signed, ...linkedHeaders(SHA, 1234) }
      queueMicrotask(() => callback(response))
      const request = new EventEmitter()
      request.setTimeout = () => request
      request.destroy = () => request
      return request
    }
  }
  const { statusCode, headers } = await fetchHeaders(HF_URL, { requester })
  assert.equal(statusCode, 302)
  assert.deepEqual(linkedIntegrity(headers), { sha256: SHA, bytes: 1234 })
})
