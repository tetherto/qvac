import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  authHeaders,
  downloadWithRetries,
  manifestModelPaths,
  markerFileName,
  selectManifestEntries,
  validateModelName,
  warmModels
} from '../warm-models.mjs'

const GOOD = Buffer.from('verified model')
const SHA256 = createHash('sha256').update(GOOD).digest('hex')
const CACHE_KEY = 'models-example-v2-base-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

function pinnedManifest(extra = {}) {
  return {
    models: {
      'model.gguf': {
        group: 'base',
        urls: ['https://example.invalid/model.gguf'],
        sha256: SHA256,
        bytes: GOOD.length,
        ...extra
      }
    }
  }
}

async function writeGood(_urls, dest) {
  await writeFile(dest, GOOD)
}

function countingDownload(counter) {
  return async (_urls, dest) => {
    counter.count++
    await writeFile(dest, GOOD)
  }
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (_) {
    return false
  }
}

// Populate a group's files + verified marker via a cold run, so a follow-up run
// can exercise the exact-hit fast path.
async function seedVerifiedCache(root, { manifest = pinnedManifest(), cacheKey = CACHE_KEY } = {}) {
  const cold = await warmModels(
    { package: 'example', root, group: 'base', exactHit: false, cacheKey },
    { download: writeGood }
  )
  assert.equal(cold.mode, 'full-download')
  return cold
}

function fixtureRequester(fixtures) {
  return {
    get(url, _options, callback) {
      const fixture = fixtures[url]
      if (!fixture) throw new Error(`missing fixture for ${url}`)
      const response = Readable.from(fixture.body || [])
      response.statusCode = fixture.statusCode || 200
      response.headers = fixture.headers || {}
      queueMicrotask(() => callback(response))
      const request = new EventEmitter()
      request.setTimeout = () => request
      request.destroy = (err) => queueMicrotask(() => request.emit('error', err))
      return request
    }
  }
}

async function withFixture(manifest, run) {
  const root = await mkdtemp(join(tmpdir(), 'qvac-warm-models-test-'))
  const integrationDir = join(root, 'packages/example/test/integration')
  await mkdir(integrationDir, { recursive: true })
  await writeFile(
    join(integrationDir, 'models.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
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

test('signed redirect URLs are redacted from warmer errors and logs', async () => {
  await withFixture({ models: {} }, async (root) => {
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
        downloadWithRetries([source], join(root, 'model.bin'), 'model.bin', {
          retries: 0,
          requester
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

test('group selection is exact and legacy selection still honors warm:false', () => {
  const manifest = {
    models: {
      'base.gguf': { group: 'base' },
      'ideogram.gguf': { group: 'ideogram', warm: false },
      'ltx.gguf': { group: 'ltx' }
    }
  }

  assert.deepEqual(
    selectManifestEntries(manifest, 'ideogram').entries.map(([name]) => name),
    ['ideogram.gguf']
  )
  assert.deepEqual(
    selectManifestEntries(manifest).entries.map(([name]) => name),
    ['base.gguf', 'ltx.gguf']
  )
  assert.deepEqual(
    selectManifestEntries(manifest, '', { includeDeferred: true }).entries.map(([name]) => name),
    ['base.gguf', 'ideogram.gguf', 'ltx.gguf'],
    'cache paths retain lazily populated warm:false files'
  )
  assert.throws(() => selectManifestEntries(manifest, 'missing'), /no models in group/)
})

test('manifest names must be plain basenames', () => {
  assert.equal(validateModelName('model.gguf'), 'model.gguf')
  for (const invalid of [
    '/tmp/model.gguf',
    '../model.gguf',
    'nested/model.gguf',
    '..\\model.gguf',
    'nested\\model.gguf',
    '.',
    '..'
  ]) {
    assert.throws(() => validateModelName(invalid), /invalid manifest model name/)
  }
  assert.throws(
    () =>
      selectManifestEntries(
        { models: { 'base.gguf': { group: 'base' }, '../ltx.gguf': { group: 'ltx' } } },
        'base'
      ),
    /invalid manifest model name/,
    'invalid names are rejected even when another group is selected'
  )
})

test('group path calculation emits exact non-overlapping manifest files', async () => {
  const manifest = {
    models: {
      'base.gguf': { group: 'base' },
      'ideogram.gguf': { group: 'ideogram' }
    }
  }
  await withFixture(manifest, async (root) => {
    const output = join(root, 'github-output')
    await warmModels({
      package: 'example',
      root,
      group: 'ideogram',
      pathsOutput: output
    })
    const contents = await readFile(output, 'utf8')
    assert.match(contents, /packages\/example\/test\/model\/ideogram\.gguf/)
    assert.doesNotMatch(contents, /base\.gguf/)
    assert.deepEqual(
      manifestModelPaths('example', selectManifestEntries(manifest, 'base').entries),
      ['packages/example/test/model/base.gguf']
    )
  })
})

test('restored files are always verified before reuse', async () => {
  const manifest = {
    models: {
      'model.gguf': {
        group: 'base',
        urls: ['https://example.invalid/model.gguf'],
        sha256: SHA256,
        bytes: GOOD.length
      }
    }
  }
  await withFixture(manifest, async (root) => {
    const modelDir = join(root, 'packages/example/test/model')
    await mkdir(modelDir, { recursive: true })
    await writeFile(join(modelDir, 'model.gguf'), Buffer.from('poisoned bytes'))
    let downloads = 0
    await warmModels(
      { package: 'example', root, group: 'base', pathsOutput: null },
      {
        async download(_urls, dest) {
          downloads++
          await writeFile(dest, GOOD)
        }
      }
    )

    assert.equal(downloads, 1)
    assert.deepEqual(await readFile(join(modelDir, 'model.gguf')), GOOD)
  })
})

test('cold run hashes files and writes a verified marker', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    const cold = await seedVerifiedCache(root)
    assert.equal(cold.hashed, 1, 'cold run hashes the downloaded file')
    const marker = JSON.parse(
      await readFile(join(root, 'packages/example/test/model', markerFileName('base')), 'utf8')
    )
    assert.equal(marker.version, 2)
    assert.equal(marker.cacheKey, CACHE_KEY)
    assert.equal(marker.modelCount, 1)
    assert.deepEqual(marker.models, [{ name: 'model.gguf', sha256: SHA256, bytes: GOOD.length }])
  })
})

test('valid exact hit skips all warm-step hashing and downloads', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    await seedVerifiedCache(root)
    const counter = { count: 0 }
    const warm = await warmModels(
      { package: 'example', root, group: 'base', exactHit: true, cacheKey: CACHE_KEY },
      { download: countingDownload(counter) }
    )
    assert.equal(warm.mode, 'marker-skip')
    assert.equal(warm.hashed, 0)
    assert.equal(warm.downloaded, 0)
    assert.equal(counter.count, 0)
  })
})

test('prefix restore (exactHit=false) never uses the fast path', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    await seedVerifiedCache(root)
    const warm = await warmModels(
      { package: 'example', root, group: 'base', exactHit: false, cacheKey: CACHE_KEY },
      { download: writeGood }
    )
    assert.notEqual(warm.mode, 'marker-skip')
    assert.equal(warm.hashed, 1, 'prefix restore re-verifies by hashing')
  })
})

test('exact hit with a missing marker falls back to full verification', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    await seedVerifiedCache(root)
    await rm(join(root, 'packages/example/test/model', markerFileName('base')), { force: true })
    const warm = await warmModels(
      { package: 'example', root, group: 'base', exactHit: true, cacheKey: CACHE_KEY },
      { download: writeGood }
    )
    assert.notEqual(warm.mode, 'marker-skip')
    assert.equal(warm.hashed, 1)
  })
})

test('exact hit with a wrong-size file cannot use the fast path', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    await seedVerifiedCache(root)
    // Corrupt the file to a different size AFTER the marker was written.
    await writeFile(join(root, 'packages/example/test/model/model.gguf'), Buffer.from('short'))
    const counter = { count: 0 }
    const warm = await warmModels(
      { package: 'example', root, group: 'base', exactHit: true, cacheKey: CACHE_KEY },
      { download: countingDownload(counter) }
    )
    assert.notEqual(warm.mode, 'marker-skip')
    assert.equal(counter.count, 1, 'a wrong-size file is re-downloaded, not trusted')
  })
})

test('exact hit with a mismatched cache key cannot use the fast path', async () => {
  await withFixture(pinnedManifest(), async (root) => {
    await seedVerifiedCache(root)
    const warm = await warmModels(
      {
        package: 'example',
        root,
        group: 'base',
        exactHit: true,
        cacheKey: 'models-example-v2-base-0000000000000000000000000000000000000000'
      },
      { download: writeGood }
    )
    assert.notEqual(warm.mode, 'marker-skip')
    assert.equal(warm.hashed, 1)
  })
})

test('unpinned entries never write a marker or enable the fast path', async () => {
  const manifest = {
    models: {
      'model.gguf': {
        group: 'base',
        urls: ['https://example.invalid/model.gguf'],
        bytes: GOOD.length
      }
    }
  }
  await withFixture(manifest, async (root) => {
    const cold = await warmModels(
      { package: 'example', root, group: 'base', exactHit: false, cacheKey: CACHE_KEY },
      { download: writeGood }
    )
    assert.notEqual(cold.mode, 'marker-skip')
    const markerPath = join(root, 'packages/example/test/model', markerFileName('base'))
    assert.equal(await fileExists(markerPath), false, 'no marker for an unpinned set')
    const warm = await warmModels(
      { package: 'example', root, group: 'base', exactHit: true, cacheKey: CACHE_KEY },
      { download: writeGood }
    )
    assert.notEqual(warm.mode, 'marker-skip')
  })
})

test('per-group markers are isolated and included in cache paths', async () => {
  const manifest = {
    models: {
      'base.gguf': { group: 'base', urls: ['https://x.invalid/b'], sha256: SHA256, bytes: 1 },
      'ideogram.gguf': { group: 'ideogram', urls: ['https://x.invalid/i'], sha256: SHA256, bytes: 1 }
    }
  }
  await withFixture(manifest, async (root) => {
    const output = join(root, 'github-output')
    await warmModels({ package: 'example', root, group: 'ideogram', pathsOutput: output })
    const contents = await readFile(output, 'utf8')
    assert.match(contents, /packages\/example\/test\/model\/\.qvac-verified-ideogram\.json/)
    assert.doesNotMatch(contents, /\.qvac-verified-base\.json/)
    assert.doesNotMatch(contents, /base\.gguf/)
    assert.notEqual(markerFileName('base'), markerFileName('ideogram'))
  })
})
