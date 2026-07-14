import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  authHeaders,
  download,
  fetchModelResult,
  validateDownloadedIntegrity
} from './generate-model-manifest.mjs'

const CONTENT = Buffer.from('canonical-model-content')
const SHA256 = createHash('sha256').update(CONTENT).digest('hex')
const ALTERNATE_CONTENT = Buffer.from('cdn-replacement-content')
const ALTERNATE_SHA256 = createHash('sha256').update(ALTERNATE_CONTENT).digest('hex')
const KNOWN_MISMATCH_URL =
  'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/12ddc22724f6da35f0b6006e459fae66eaf56931/stable-diffusion-v2-1-Q4_0.gguf'
const KNOWN_SOURCE_SHA256 = '3bc6163b7e7979aab49cc9dd76a98b99945f6a3cca8ba14411d730380c1a10e1'
const KNOWN_RUNTIME_SHA256 = '27740067fae2c988f64839ae806d989eb6d5aa6cfe5d47c8994c100677ef97e4'
const KNOWN_BYTES = 2185459424

function fixtureRequester(fixtures, requests = []) {
  return {
    get(url, options, callback) {
      const fixture = fixtures[url]
      if (!fixture) throw new Error(`missing fixture for ${url}`)
      requests.push({ url, headers: { ...options.headers } })
      const response = Readable.from(fixture.body || [])
      response.statusCode = fixture.statusCode || 200
      response.headers = fixture.headers || {}
      if (fixture.onResponse) fixture.onResponse(response)
      queueMicrotask(() => callback(response))
      return new EventEmitter()
    }
  }
}

async function withTmp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-manifest-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function canonicalHeaders(overrides = {}) {
  return {
    'x-linked-etag': `"${SHA256}"`,
    'x-linked-size': String(CONTENT.length),
    ...overrides
  }
}

test('HF token is sent only to the exact huggingface.co hostname', () => {
  assert.equal(
    authHeaders('https://huggingface.co/org/repo/resolve/rev/model', 'secret').authorization,
    'Bearer secret'
  )
  assert.equal(
    authHeaders('https://huggingface.co.evil.test/model', 'secret').authorization,
    undefined
  )
  assert.equal(authHeaders('https://not-huggingface.co/model', 'secret').authorization, undefined)
  assert.equal(authHeaders('http://huggingface.co/model', 'secret').authorization, undefined)
})

test('cross-host redirects strip the Hugging Face token', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const redirected = 'https://cdn.example.test/model.bin'
    const requests = []
    const requester = fixtureRequester(
      {
        [source]: {
          statusCode: 302,
          headers: { ...canonicalHeaders(), location: redirected }
        },
        [redirected]: { body: CONTENT }
      },
      requests
    )
    const previousToken = process.env.HF_TOKEN
    process.env.HF_TOKEN = 'secret'
    try {
      await download(source, join(dir, 'model.bin'), { requester })
    } finally {
      if (previousToken === undefined) delete process.env.HF_TOKEN
      else process.env.HF_TOKEN = previousToken
    }

    assert.equal(requests[0].headers.authorization, 'Bearer secret')
    assert.equal(requests[1].headers.authorization, undefined)
  })
})

test('Hugging Face LFS downloads require canonical SHA and size metadata', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const requester = fixtureRequester({ [source]: { body: CONTENT } })
    await assert.rejects(
      download(source, join(dir, 'model.bin'), { requester }),
      /missing canonical Hugging Face LFS SHA-256\/size metadata/
    )
  })
})

test('CDN metadata cannot fill metadata omitted by Hugging Face', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const redirected = 'https://cdn.example.test/model.bin?signature=secret'
    const requester = fixtureRequester({
      [source]: { statusCode: 302, headers: { location: redirected } },
      [redirected]: { body: CONTENT, headers: canonicalHeaders() }
    })

    await assert.rejects(
      download(source, join(dir, 'model.bin'), { requester }),
      /missing canonical Hugging Face LFS SHA-256\/size metadata/
    )
  })
})

test('CDN metadata cannot replace inherited Hugging Face metadata', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const redirected = 'https://cdn.example.test/model.bin?signature=secret'
    const requester = fixtureRequester({
      [source]: {
        statusCode: 302,
        headers: { ...canonicalHeaders(), location: redirected }
      },
      [redirected]: {
        body: ALTERNATE_CONTENT,
        headers: {
          'x-linked-etag': `"${ALTERNATE_SHA256}"`,
          'x-linked-size': String(ALTERNATE_CONTENT.length)
        }
      }
    })

    await assert.rejects(
      fetchModelResult('model.bin', { urls: [source] }, dir, {
        downloadFile: (url, dest) => download(url, dest, { requester })
      }),
      new RegExp(`does not match source LFS OID ${SHA256}`)
    )
  })
})

test('conflicting authoritative metadata consumes the response before rejection', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const second = 'https://huggingface.co/org/repo/resolve/rev/model-redirect.bin'
    let conflictingResponse
    const requester = fixtureRequester({
      [source]: {
        statusCode: 302,
        headers: { ...canonicalHeaders(), location: second }
      },
      [second]: {
        statusCode: 302,
        body: CONTENT,
        headers: {
          ...canonicalHeaders({ 'x-linked-etag': `"${ALTERNATE_SHA256}"` }),
          location: 'https://cdn.example.test/model.bin'
        },
        onResponse(response) {
          conflictingResponse = response
        }
      }
    })

    await assert.rejects(
      download(source, join(dir, 'model.bin'), { requester }),
      /conflicting canonical Hugging Face LFS sha256 metadata/
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(
      conflictingResponse.readableEnded || conflictingResponse.destroyed,
      'response was consumed or destroyed'
    )
  })
})

test('signed URL credentials and query values are redacted from errors and logs', async () => {
  await withTmp(async (dir) => {
    const source = 'https://example.test/model.bin'
    const signed =
      'https://user:password@cdn.example.test/model.bin?X-Amz-Credential=sensitive#fragment'
    const requester = fixtureRequester({
      [source]: { statusCode: 302, headers: { location: signed } },
      [signed]: { statusCode: 403 }
    })
    const logs = []
    const originalLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    try {
      await assert.rejects(
        fetchModelResult('model.bin', { urls: [source] }, dir, {
          downloadFile: (url, dest) => download(url, dest, { requester })
        }),
        (err) => {
          assert.match(err.message, /https:\/\/cdn\.example\.test\/model\.bin/)
          assert.doesNotMatch(err.message, /user|password|X-Amz|sensitive|fragment/)
          return true
        }
      )
    } finally {
      console.log = originalLog
    }
    assert.doesNotMatch(logs.join('\n'), /user|password|X-Amz|sensitive|fragment/)
  })
})

test('canonical LFS SHA mismatch rejects the attempt', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const requester = fixtureRequester({
      [source]: {
        body: CONTENT,
        headers: canonicalHeaders({ 'x-linked-etag': `"${'0'.repeat(64)}"` })
      }
    })
    await assert.rejects(
      fetchModelResult('model.bin', { urls: [source] }, dir, {
        downloadFile: (url, dest) => download(url, dest, { requester })
      }),
      /does not match source LFS OID/
    )
  })
})

test('canonical LFS size mismatch rejects the attempt', async () => {
  await withTmp(async (dir) => {
    const source = 'https://huggingface.co/org/repo/resolve/rev/model.bin'
    const requester = fixtureRequester({
      [source]: {
        body: CONTENT,
        headers: canonicalHeaders({ 'x-linked-size': String(CONTENT.length + 1) })
      }
    })
    await assert.rejects(
      fetchModelResult('model.bin', { urls: [source] }, dir, {
        downloadFile: (url, dest) => download(url, dest, { requester })
      }),
      /does not match source size/
    )
  })
})

test('a documented source/runtime mismatch is now rejected fail-closed', () => {
  // The former `sourceSha256`/`sourceBytes` exception is gone: a source whose
  // delivered bytes differ from its immutable content address is unauditable
  // and must be rejected, not documented. The gpustack SD2.1 Q4_0 file is the
  // real-world case that motivated this (legacy-LFS blob whose bytes hash to
  // 27740067… while its pointer OID is 3bc6163b…).
  assert.throws(
    () =>
      validateDownloadedIntegrity({
        url: KNOWN_MISMATCH_URL,
        entry: {
          urls: [KNOWN_MISMATCH_URL],
          sha256: KNOWN_RUNTIME_SHA256,
          bytes: KNOWN_BYTES
        },
        expected: { sha256: KNOWN_SOURCE_SHA256, bytes: KNOWN_BYTES },
        candidate: { sha256: KNOWN_RUNTIME_SHA256, bytes: KNOWN_BYTES }
      }),
    /does not match source LFS OID/
  )
})

test('legacy source-exception fields are ignored and cannot re-enable acceptance', () => {
  // Even if an entry still carried the old exception fields, they must not
  // create an accepted path around a content-address mismatch.
  assert.throws(
    () =>
      validateDownloadedIntegrity({
        url: KNOWN_MISMATCH_URL,
        entry: {
          urls: [KNOWN_MISMATCH_URL],
          sha256: KNOWN_RUNTIME_SHA256,
          bytes: KNOWN_BYTES,
          sourceSha256: KNOWN_SOURCE_SHA256,
          sourceBytes: KNOWN_BYTES
        },
        expected: { sha256: KNOWN_SOURCE_SHA256, bytes: KNOWN_BYTES },
        candidate: { sha256: KNOWN_RUNTIME_SHA256, bytes: KNOWN_BYTES }
      }),
    /does not match source LFS OID/
  )
})

test('failed canonical source is cleared before a fallback URL succeeds', async () => {
  await withTmp(async (dir) => {
    const first = 'https://huggingface.co/org/repo/resolve/rev/bad.bin'
    const fallback = 'https://huggingface.co/org/repo/resolve/rev/good.bin'
    const requester = fixtureRequester({
      [first]: {
        body: Buffer.from('poisoned'),
        headers: canonicalHeaders()
      },
      [fallback]: {
        body: CONTENT,
        headers: canonicalHeaders()
      }
    })
    const result = await fetchModelResult('model.bin', { urls: [first, fallback] }, dir, {
      downloadFile: (url, dest) => download(url, dest, { requester })
    })

    assert.deepEqual(result, { sha256: SHA256, bytes: CONTENT.length })
    await assert.rejects(readFile(join(dir, 'model.bin')), /ENOENT/)
  })
})
