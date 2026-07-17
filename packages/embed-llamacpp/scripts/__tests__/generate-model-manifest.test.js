'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { Readable } = require('node:stream')

const SHA256 = 'a'.repeat(64)
const OTHER_SHA256 = 'b'.repeat(64)
let manifestGenerator

test.before(async () => {
  manifestGenerator = await import('../generate-model-manifest.mjs')
})

function response(statusCode, headers = {}, body = '') {
  const stream = Readable.from(body === '' ? [] : [body])
  stream.statusCode = statusCode
  stream.headers = headers
  return stream
}

function requestSequence(responses, calls) {
  return function (url, options, callback) {
    calls.push({ url, headers: options.headers })
    const req = new EventEmitter()
    const nextResponse = responses.shift()
    process.nextTick(() => callback(nextResponse))
    return req
  }
}

test('auth is limited to the exact trusted Hugging Face hostname', () => {
  const { authHeaders } = manifestGenerator
  const token = 'hf_secret'

  assert.equal(
    authHeaders('https://huggingface.co/org/model', token).authorization,
    `Bearer ${token}`
  )
  assert.equal(
    authHeaders('https://huggingface.co.evil.example/org/model', token).authorization,
    undefined
  )
  assert.equal(authHeaders('https://not-huggingface.co/org/model', token).authorization, undefined)
  assert.throws(() => authHeaders('not a URL', token), /invalid URL/)
})

test('cross-host redirects strip the Hugging Face token', async () => {
  const { download } = manifestGenerator
  const calls = []
  const responses = [
    response(302, {
      location: 'https://cdn-lfs.example/model.gguf',
      'x-linked-etag': `"${SHA256}"`,
      'x-linked-size': '5'
    }),
    response(
      200,
      {
        'x-linked-etag': `"${OTHER_SHA256}"`,
        'x-linked-size': '999'
      },
      'model'
    )
  ]
  const dir = await mkdtemp(join(tmpdir(), 'qvac-manifest-test-'))
  const dest = join(dir, 'model.gguf')

  try {
    const metadata = await download(
      'https://huggingface.co/org/repo/resolve/revision/model.gguf',
      dest,
      {
        token: 'hf_secret',
        request: requestSequence(responses, calls)
      }
    )

    assert.equal(calls.length, 2)
    assert.equal(calls[0].headers.authorization, 'Bearer hf_secret')
    assert.equal(calls[1].url.hostname, 'cdn-lfs.example')
    assert.equal(calls[1].headers.authorization, undefined)
    assert.deepEqual(metadata, { sha256: SHA256, bytes: 5 })
    assert.equal(await readFile(dest, 'utf8'), 'model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cross-host responses cannot originate canonical metadata', async () => {
  const { download } = manifestGenerator
  const calls = []
  const responses = [
    response(
      200,
      {
        'x-linked-etag': `"${OTHER_SHA256}"`,
        'x-linked-size': '999'
      },
      'model'
    )
  ]
  const dir = await mkdtemp(join(tmpdir(), 'qvac-manifest-test-'))
  const dest = join(dir, 'model.gguf')

  try {
    const metadata = await download('https://cdn-lfs.example/model.gguf', dest, {
      request: requestSequence(responses, calls)
    })

    assert.equal(metadata, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Hugging Face LFS redirects require canonical metadata', async () => {
  const { CanonicalMetadataError, download } = manifestGenerator
  const calls = []
  const responses = [
    response(302, {
      location: 'https://cdn-lfs.example/model.gguf'
    })
  ]

  await assert.rejects(
    download('https://huggingface.co/org/repo/resolve/revision/model.gguf', '/unused', {
      request: requestSequence(responses, calls)
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /incomplete Hugging Face LFS metadata/)
      return true
    }
  )
  assert.equal(calls.length, 1)
})

test('direct Hugging Face GGUF responses require canonical metadata', async () => {
  const { CanonicalMetadataError, download } = manifestGenerator
  const calls = []

  await assert.rejects(
    download('https://huggingface.co/org/repo/resolve/revision/model.gguf', '/unused', {
      request: requestSequence([response(200, {}, 'model')], calls)
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /incomplete Hugging Face LFS metadata/)
      return true
    }
  )
  assert.equal(calls.length, 1)
})

test('metadata parsing failures consume the response before rejecting', async () => {
  const { CanonicalMetadataError, download } = manifestGenerator
  const calls = []
  const invalidMetadataResponse = response(
    200,
    {
      'x-linked-etag': 'not-a-sha256',
      'x-linked-size': '5'
    },
    'model'
  )
  const resume = invalidMetadataResponse.resume.bind(invalidMetadataResponse)
  let resumeCalls = 0
  invalidMetadataResponse.resume = function () {
    resumeCalls++
    return resume()
  }

  await assert.rejects(
    download('https://huggingface.co/org/repo/resolve/revision/model.gguf', '/unused', {
      request: requestSequence([invalidMetadataResponse], calls)
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      return true
    }
  )
  assert.equal(resumeCalls, 1)
})

test('metadata merge failures consume the final response before rejecting', async () => {
  const { CanonicalMetadataError, download } = manifestGenerator
  const calls = []
  const conflictingResponse = response(
    200,
    {
      'x-linked-etag': `"${OTHER_SHA256}"`,
      'x-linked-size': '5'
    },
    'model'
  )
  const resume = conflictingResponse.resume.bind(conflictingResponse)
  let resumeCalls = 0
  conflictingResponse.resume = function () {
    resumeCalls++
    return resume()
  }
  const responses = [
    response(302, {
      location: 'https://huggingface.co/org/repo/resolve/revision/model-redirect.gguf',
      'x-linked-etag': `"${SHA256}"`,
      'x-linked-size': '5'
    }),
    conflictingResponse
  ]

  await assert.rejects(
    download('https://huggingface.co/org/repo/resolve/revision/model.gguf', '/unused', {
      request: requestSequence(responses, calls)
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /conflicting Hugging Face LFS metadata/)
      return true
    }
  )
  assert.equal(resumeCalls, 1)
})

test('direct non-LFS Hugging Face responses do not require LFS metadata', async () => {
  const { download } = manifestGenerator
  const calls = []
  const responses = [response(200, {}, 'config')]
  const dir = await mkdtemp(join(tmpdir(), 'qvac-manifest-test-'))
  const dest = join(dir, 'config.json')

  try {
    const metadata = await download(
      'https://huggingface.co/org/repo/resolve/revision/config.json',
      dest,
      { request: requestSequence(responses, calls) }
    )

    assert.equal(metadata, null)
    assert.equal(await readFile(dest, 'utf8'), 'config')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('signed URL secrets are redacted from thrown errors and logs', async () => {
  const { download, generateModelPin } = manifestGenerator
  const signedUrl =
    'https://username:password@cdn-lfs.example/model.gguf?Policy=POLICY_SECRET&Signature=SIGNATURE_SECRET&X-Amz-Credential=CREDENTIAL_SECRET#FRAGMENT_SECRET'
  const logs = []
  const calls = []
  const entry = { urls: [signedUrl] }

  await assert.rejects(
    generateModelPin('model.gguf', entry, '/tmp', {
      downloadFile: (url, dest) =>
        download(url, dest, {
          request: requestSequence([response(500)], calls)
        }),
      removeFile: () => Promise.resolve(),
      logger: { log: (message) => logs.push(message) }
    }),
    (err) => {
      const output = [
        err.message,
        err.stack,
        err.cause && err.cause.message,
        err.cause && err.cause.stack,
        ...logs
      ].join('\n')

      assert.match(output, /https:\/\/cdn-lfs\.example\/model\.gguf/)
      for (const secret of [
        'username',
        'password',
        'Policy',
        'POLICY_SECRET',
        'Signature',
        'SIGNATURE_SECRET',
        'X-Amz-Credential',
        'CREDENTIAL_SECRET',
        'FRAGMENT_SECRET'
      ]) {
        assert.doesNotMatch(output, new RegExp(secret))
      }
      return true
    }
  )
})

test('metadata mismatch cannot produce a model pin', async () => {
  const { CanonicalMetadataError, generateModelPin } = manifestGenerator
  const entry = {
    urls: ['https://huggingface.co/org/repo/resolve/revision/model.gguf']
  }

  await assert.rejects(
    generateModelPin('model.gguf', entry, '/tmp', {
      downloadFile: () => Promise.resolve({ sha256: SHA256, bytes: 5 }),
      hashFile: () => Promise.resolve({ sha256: 'b'.repeat(64), bytes: 5 }),
      removeFile: () => Promise.resolve(),
      logger: { log() {} }
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /SHA-256 mismatch/)
      return true
    }
  )

  await assert.rejects(
    generateModelPin('model.gguf', entry, '/tmp', {
      downloadFile: () => Promise.resolve({ sha256: SHA256, bytes: 5 }),
      hashFile: () => Promise.resolve({ sha256: SHA256, bytes: 4 }),
      removeFile: () => Promise.resolve(),
      logger: { log() {} }
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /size mismatch/)
      return true
    }
  )
})

test('falls back after a source failure and returns the second source pin', async () => {
  const { generateModelPin } = manifestGenerator
  const urls = ['https://first.example/model.gguf', 'https://second.example/model.gguf']
  const attempts = []
  const expected = { sha256: SHA256, bytes: 5 }

  const result = await generateModelPin('model.gguf', { urls }, '/tmp', {
    downloadFile: (url) => {
      attempts.push(url)
      if (url === urls[0]) return Promise.reject(new Error('first failed'))
      return Promise.resolve(null)
    },
    hashFile: () => Promise.resolve(expected),
    removeFile: () => Promise.resolve(),
    logger: { log() {} }
  })

  assert.deepEqual(attempts, urls)
  assert.deepEqual(result, expected)
})

test('all source failures preserve the final failure as cause', async () => {
  const { generateModelPin } = manifestGenerator
  const firstError = new Error('first socket closed')
  const finalError = new Error('second socket closed')
  const failures = [firstError, finalError]
  const entry = {
    urls: ['https://first.example/model.gguf', 'https://second.example/model.gguf']
  }

  await assert.rejects(
    generateModelPin('model.gguf', entry, '/tmp', {
      downloadFile: () => Promise.reject(failures.shift()),
      removeFile: () => Promise.resolve(),
      logger: { log() {} }
    }),
    (err) => {
      assert.match(err.message, /failed to fetch model\.gguf: second socket closed/)
      assert.equal(err.cause, finalError)
      return true
    }
  )
})

test('canonical post-hash failure cannot fall back or return a stale candidate', async () => {
  const { CanonicalMetadataError, generateModelPin } = manifestGenerator
  const urls = [
    'https://huggingface.co/org/repo/resolve/revision/model.gguf',
    'https://backup.example/model.gguf'
  ]
  const attempts = []

  await assert.rejects(
    generateModelPin('model.gguf', { urls }, '/tmp', {
      downloadFile: (url) => {
        attempts.push(url)
        return Promise.resolve({ sha256: SHA256, bytes: 5 })
      },
      hashFile: () => Promise.resolve({ sha256: OTHER_SHA256, bytes: 5 }),
      removeFile: () => Promise.resolve(),
      logger: { log() {} }
    }),
    (err) => {
      assert.ok(err instanceof CanonicalMetadataError)
      assert.match(err.message, /SHA-256 mismatch/)
      return true
    }
  )
  assert.deepEqual(attempts, [urls[0]])
})
