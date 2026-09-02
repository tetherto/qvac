import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'bare-crypto'
import { resolveFallbackModel, resolveRegistryModel } from '@/handlers/load-model/resolve'
import {
  ChecksumValidationFailedError,
  DownloadCancelledError,
  InferenceCancelledError,
  ModelLoadFailedError
} from '@/errors/index'

// -----------------------------------------------------------------------------
// loadModel fallbackSrc.
//
// `resolveRegistryModel` is the pure primary/fallback decision. `resolveFallbackModel`
// resolves a non-P2P source and validates it against the catalog checksum.
// Schema-level acceptance of `fallbackSrc` lives in load-model-schema.test.ts.
// -----------------------------------------------------------------------------

function writeTempFile(name: string, content: string) {
  const dir = path.join(os.cwd(), 'test', 'tmp-fallback-bare')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content)
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true }) }
}

function sha256Hex(content: string) {
  const hash = crypto.createHash('sha-256')
  hash.update(content)
  return hash.digest('hex')
}

test('resolveRegistryModel: returns the primary result and skips fallback on success', async (t) => {
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
  const content = 'fallback model bytes'
  const { filePath, cleanup } = writeTempFile('match.gguf', content)
  try {
    const checksum = sha256Hex(content)
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

test('resolveFallbackModel: rejects a mismatched local file and keeps it in place', async (t) => {
  const { filePath, cleanup } = writeTempFile('mismatch.gguf', 'fallback model bytes')
  try {
    try {
      await resolveFallbackModel(filePath, 'a'.repeat(64), undefined, 'base', undefined, undefined)
      t.fail('expected a checksum mismatch to throw')
    } catch (err) {
      t.ok(err instanceof ChecksumValidationFailedError)
    }
    t.ok(fs.existsSync(filePath), 'the fallback file is left in place')
  } finally {
    cleanup()
  }
})

test('resolveFallbackModel: skips validation when no checksum is known', async (t) => {
  const { filePath, cleanup } = writeTempFile('unchecked.gguf', 'fallback model bytes')
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
