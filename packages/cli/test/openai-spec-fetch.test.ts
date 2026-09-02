import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { parseSpecWithDependencies } from '@/openai/coverage/parse-spec'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_SPEC = join(TEST_DIR, 'fixtures', 'openai-spec-mini.yaml')
const SPEC_CACHE_NAME = 'openai-spec.yaml'
const ETAG_CACHE_NAME = 'openai-spec.etag'
const SHA_CACHE_NAME = 'openai-spec.sha256'

function dependencies(
  cacheDir: string,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  timeoutMs = 100
) {
  return { cacheDir, fetch: fetchImpl, timeoutMs }
}

describe('OpenAI specification fetch and cache', () => {
  it('hashes and atomically caches a validated HTTP 200 specification', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      const result = await parseSpecWithDependencies(
        {},
        dependencies(cacheDir, () =>
          Promise.resolve(
            new Response(yaml, {
              status: 200,
              headers: { etag: '"fixture-v1"' }
            })
          )
        )
      )

      assert.equal(result.sourceMode, 'live')
      assert.equal(result.sha256, createHash('sha256').update(yaml).digest('hex'))
      assert.equal(readFileSync(join(cacheDir, SPEC_CACHE_NAME), 'utf8'), yaml)
      assert.equal(readFileSync(join(cacheDir, ETAG_CACHE_NAME), 'utf8'), '"fixture-v1"')
      assert.equal(
        readFileSync(join(cacheDir, SHA_CACHE_NAME), 'utf8'),
        createHash('sha256').update(yaml).digest('hex')
      )
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('distinguishes an ETag-validated cached specification after HTTP 304', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      const expectedSha256 = createHash('sha256').update(yaml).digest('hex')
      writeFileSync(join(cacheDir, SPEC_CACHE_NAME), yaml)
      writeFileSync(join(cacheDir, ETAG_CACHE_NAME), '"fixture-v1"')
      writeFileSync(join(cacheDir, SHA_CACHE_NAME), expectedSha256)

      const result = await parseSpecWithDependencies(
        {},
        dependencies(cacheDir, (_input, init) => {
          assert.deepEqual(init?.headers, { 'If-None-Match': '"fixture-v1"' })
          return Promise.resolve(new Response(null, { status: 304 }))
        })
      )

      assert.equal(result.sourceMode, 'live-validated-cache')
      assert.equal(result.sha256, expectedSha256)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('repairs a hash-mismatched cached specification after HTTP 304', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      const tamperedYaml = yaml.replace('createChatCompletion', 'tamperedChatCompletion')
      const expectedSha256 = createHash('sha256').update(yaml).digest('hex')
      writeFileSync(join(cacheDir, SPEC_CACHE_NAME), tamperedYaml)
      writeFileSync(join(cacheDir, ETAG_CACHE_NAME), '"fixture-v1"')
      writeFileSync(join(cacheDir, SHA_CACHE_NAME), expectedSha256)
      let calls = 0

      const result = await parseSpecWithDependencies(
        {},
        dependencies(cacheDir, (_input, init) => {
          calls += 1
          if (calls === 1) {
            assert.deepEqual(init?.headers, { 'If-None-Match': '"fixture-v1"' })
            return Promise.resolve(new Response(null, { status: 304 }))
          }
          assert.deepEqual(init?.headers, {})
          return Promise.resolve(
            new Response(yaml, {
              status: 200,
              headers: { etag: '"fixture-v2"' }
            })
          )
        })
      )

      assert.equal(calls, 2)
      assert.equal(result.sourceMode, 'live')
      assert.equal(result.sha256, expectedSha256)
      assert.equal(readFileSync(join(cacheDir, SPEC_CACHE_NAME), 'utf8'), yaml)
      assert.equal(readFileSync(join(cacheDir, SHA_CACHE_NAME), 'utf8'), expectedSha256)
      assert.equal(readFileSync(join(cacheDir, ETAG_CACHE_NAME), 'utf8'), '"fixture-v2"')
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('removes a stale cached ETag when a new HTTP 200 response omits it', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      writeFileSync(join(cacheDir, ETAG_CACHE_NAME), '"stale"')

      await parseSpecWithDependencies(
        {},
        dependencies(cacheDir, () => Promise.resolve(new Response(yaml, { status: 200 })))
      )

      assert.throws(() => readFileSync(join(cacheDir, ETAG_CACHE_NAME), 'utf8'), /ENOENT/)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('preserves the last known-good cache when a live candidate is invalid', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      writeFileSync(join(cacheDir, SPEC_CACHE_NAME), yaml)

      await assert.rejects(
        parseSpecWithDependencies(
          {},
          dependencies(cacheDir, () =>
            Promise.resolve(new Response('openapi: 3.0.0\npaths: {}\n', { status: 200 }))
          )
        ),
        /no supported HTTP operations/
      )
      assert.equal(readFileSync(join(cacheDir, SPEC_CACHE_NAME), 'utf8'), yaml)

      const offline = await parseSpecWithDependencies(
        { offline: true },
        dependencies(cacheDir, () => Promise.reject(new Error('must not fetch')))
      )
      assert.equal(offline.sourceMode, 'offline-cache')
      assert.equal(offline.sha256, createHash('sha256').update(yaml).digest('hex'))
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('rejects a hash-mismatched offline cache', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      const yaml = readFileSync(FIXTURE_SPEC, 'utf8')
      const tamperedYaml = yaml.replace('createChatCompletion', 'tamperedChatCompletion')
      writeFileSync(join(cacheDir, SPEC_CACHE_NAME), tamperedYaml)
      writeFileSync(join(cacheDir, SHA_CACHE_NAME), createHash('sha256').update(yaml).digest('hex'))

      await assert.rejects(
        parseSpecWithDependencies(
          { offline: true },
          dependencies(cacheDir, () => Promise.reject(new Error('must not fetch')))
        ),
        /cached OpenAI specification hash mismatch/
      )
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  it('bounds a stalled live fetch with the configured timeout', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'openai-spec-cache-'))
    try {
      await assert.rejects(
        parseSpecWithDependencies(
          {},
          dependencies(
            cacheDir,
            (_input, init) =>
              new Promise((_resolve, reject) => {
                const signal = init?.signal
                assert.ok(signal)
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
              }),
            5
          )
        ),
        (error) => error instanceof DOMException && error.name === 'TimeoutError'
      )
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
