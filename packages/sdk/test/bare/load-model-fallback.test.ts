import test from 'brittle'

// -----------------------------------------------------------------------------
// loadModel fallbackSrc — Bare runtime tests.
//
// `resolveRegistryModel` is the pure primary/fallback decision. `resolveFallbackModel`
// resolves a non-P2P source and validates it against the catalog checksum; it
// needs the Bare runtime (bare-fs, bare-crypto) and runs via `npm run test:bare`.
//
// Schema-level acceptance of `fallbackSrc` lives in test/unit/load-model-schema.test.ts.
// -----------------------------------------------------------------------------

async function writeTempFile(name: string, content: string) {
  const barePath = await import('bare-path')
  const bareFs = await import('bare-fs')
  const bareOs = await import('bare-os')

  const dir = barePath.join(bareOs.cwd(), 'test', 'tmp-fallback-bare')
  bareFs.mkdirSync(dir, { recursive: true })
  const filePath = barePath.join(dir, name)
  bareFs.writeFileSync(filePath, content)
  return { filePath, cleanup: () => bareFs.rmSync(dir, { recursive: true }) }
}

async function sha256Hex(content: string) {
  const crypto = await import('bare-crypto')
  const hash = crypto.createHash('sha-256')
  hash.update(content)
  return hash.digest('hex')
}

test('resolveRegistryModel: returns the primary result and skips fallback on success', async (t) => {
  const { resolveRegistryModel } = await import('@/server/rpc/handlers/load-model/resolve')

  let fallbackCalls = 0
  let unreachableCalls = 0
  const result = await resolveRegistryModel({
    hasFallback: true,
    isKnownModel: true,
    downloadPrimary: async () => ({ path: '/primary.gguf', sourceType: 'registry' }),
    resolveFallback: async () => {
      fallbackCalls++
      return { path: '/fallback.gguf', sourceType: 'http' }
    },
    buildUnreachableError: () => {
      unreachableCalls++
      return new Error('unreachable')
    }
  })

  t.is(result.path, '/primary.gguf')
  t.is(fallbackCalls, 0)
  t.is(unreachableCalls, 0)
})

test('resolveRegistryModel: uses the fallback when the primary fails', async (t) => {
  const { resolveRegistryModel } = await import('@/server/rpc/handlers/load-model/resolve')

  let unreachableCalls = 0
  const result = await resolveRegistryModel({
    hasFallback: true,
    isKnownModel: true,
    downloadPrimary: async () => {
      throw new Error('network down')
    },
    resolveFallback: async () => ({ path: '/fallback.gguf', sourceType: 'http' }),
    buildUnreachableError: () => {
      unreachableCalls++
      return new Error('unreachable')
    }
  })

  t.is(result.path, '/fallback.gguf')
  t.is(result.sourceType, 'http')
  t.is(unreachableCalls, 0)
})

test('resolveRegistryModel: known model without fallback surfaces the neutral error', async (t) => {
  const { resolveRegistryModel } = await import('@/server/rpc/handlers/load-model/resolve')

  const neutral = new Error('pass a fallbackSrc')
  let unreachableCalls = 0
  try {
    await resolveRegistryModel({
      hasFallback: false,
      isKnownModel: true,
      downloadPrimary: async () => {
        throw new Error('network down')
      },
      resolveFallback: async () => {
        t.fail('fallback must not run without fallbackSrc')
        return { path: '', sourceType: 'http' }
      },
      buildUnreachableError: (cause) => {
        unreachableCalls++
        t.is((cause as Error).message, 'network down')
        return neutral
      }
    })
    t.fail('expected the neutral error to be thrown')
  } catch (err) {
    t.is(err, neutral)
    t.is(unreachableCalls, 1)
  }
})

test('resolveRegistryModel: unknown model without fallback rethrows the original error', async (t) => {
  const { resolveRegistryModel } = await import('@/server/rpc/handlers/load-model/resolve')

  const original = new Error('boom')
  try {
    await resolveRegistryModel({
      hasFallback: false,
      isKnownModel: false,
      downloadPrimary: async () => {
        throw original
      },
      resolveFallback: async () => {
        t.fail('fallback must not run')
        return { path: '', sourceType: 'http' }
      },
      buildUnreachableError: () => {
        t.fail('unreachable error must not be built for an unknown model')
        return new Error('unreachable')
      }
    })
    t.fail('expected the original error to be thrown')
  } catch (err) {
    t.is(err, original)
  }
})

test('resolveRegistryModel: a cancel propagates and never triggers the fallback', async (t) => {
  const { resolveRegistryModel } = await import('@/server/rpc/handlers/load-model/resolve')
  const { InferenceCancelledError, DownloadCancelledError } = await import('@/utils/errors-server')

  for (const cancel of [new InferenceCancelledError('req-1'), new DownloadCancelledError()]) {
    try {
      await resolveRegistryModel({
        hasFallback: true,
        isKnownModel: true,
        downloadPrimary: async () => {
          throw cancel
        },
        resolveFallback: async () => {
          t.fail('fallback must not run on cancel')
          return { path: '', sourceType: 'http' }
        },
        buildUnreachableError: () => {
          t.fail('unreachable error must not be built on cancel')
          return new Error('unreachable')
        }
      })
      t.fail('expected the cancel to be rethrown')
    } catch (err) {
      t.is(err, cancel)
    }
  }
})

test('resolveFallbackModel: rejects P2P fallback sources', async (t) => {
  const { resolveFallbackModel } = await import('@/server/rpc/handlers/load-model/resolve')
  const { ModelLoadFailedError } = await import('@/utils/errors-server')

  for (const src of ['registry://hf/known/model.gguf', 'pear://abc/model.gguf']) {
    try {
      await resolveFallbackModel(src, undefined, undefined, 'base', undefined, undefined)
      t.fail(`expected ${src} to be rejected`)
    } catch (err) {
      t.ok(err instanceof ModelLoadFailedError, `${src} rejected as ModelLoadFailedError`)
    }
  }
})

test('resolveFallbackModel: accepts a local file whose checksum matches', async (t) => {
  const { resolveFallbackModel } = await import('@/server/rpc/handlers/load-model/resolve')

  const content = 'fallback model bytes'
  const { filePath, cleanup } = await writeTempFile('match.gguf', content)
  try {
    const checksum = await sha256Hex(content)
    const result = await resolveFallbackModel(
      filePath,
      checksum,
      undefined,
      'base',
      undefined,
      undefined
    )
    t.is(result.path, filePath)
    t.is(result.sourceType, 'filesystem')
  } finally {
    cleanup()
  }
})

test('resolveFallbackModel: rejects a local file whose checksum mismatches and keeps the file', async (t) => {
  const { resolveFallbackModel } = await import('@/server/rpc/handlers/load-model/resolve')
  const { ChecksumValidationFailedError } = await import('@/utils/errors-server')
  const bareFs = await import('bare-fs')

  const { filePath, cleanup } = await writeTempFile('mismatch.gguf', 'fallback model bytes')
  try {
    const wrongChecksum = 'a'.repeat(64)
    try {
      await resolveFallbackModel(filePath, wrongChecksum, undefined, 'base', undefined, undefined)
      t.fail('expected a checksum mismatch to throw')
    } catch (err) {
      t.ok(err instanceof ChecksumValidationFailedError)
    }
    // A user's local file must never be deleted on a checksum mismatch.
    t.ok(bareFs.existsSync(filePath), 'the fallback file is left in place')
  } finally {
    cleanup()
  }
})

test('resolveFallbackModel: skips validation when no checksum is known', async (t) => {
  const { resolveFallbackModel } = await import('@/server/rpc/handlers/load-model/resolve')

  const { filePath, cleanup } = await writeTempFile('unchecked.gguf', 'fallback model bytes')
  try {
    const result = await resolveFallbackModel(
      filePath,
      undefined,
      undefined,
      'base',
      undefined,
      undefined
    )
    t.is(result.path, filePath)
  } finally {
    cleanup()
  }
})
