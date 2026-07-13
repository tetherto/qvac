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
  selectManifestEntries,
  validateModelName,
  warmModels
} from '../warm-models.mjs'

const GOOD = Buffer.from('verified model')
const SHA256 = createHash('sha256').update(GOOD).digest('hex')

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
