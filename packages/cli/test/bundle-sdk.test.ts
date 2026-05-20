import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundleSdk } from '../src/bundle-sdk/index.js'
import { WorkerEntryNotFoundError } from '../src/errors.js'

async function withFakeSdkProject (
  fn: (dir: string) => Promise<void> | void,
  configBody?: Record<string, unknown>
): Promise<void> {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-sdk-test-'))
  )
  try {
    const sdkDir = path.join(dir, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(sdkDir, { recursive: true })
    fs.writeFileSync(
      path.join(sdkDir, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', version: '0.0.0-test' })
    )
    // Minimal bare-imports.json so resolveImportsMapPath doesn't throw.
    fs.writeFileSync(path.join(sdkDir, 'bare-imports.json'), JSON.stringify({}))

    if (configBody !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'qvac.config.json'),
        JSON.stringify(configBody, null, 2)
      )
    }

    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('bundleSdk: custom workerEntry option', () => {
  it('throws WorkerEntryNotFoundError when --entry points to a missing file', async () => {
    await withFakeSdkProject(async (dir) => {
      await assert.rejects(
        () =>
          bundleSdk({
            projectRoot: dir,
            workerEntry: 'worker/does-not-exist.js',
            quiet: true
          }),
        (err: unknown) => {
          assert.ok(err instanceof WorkerEntryNotFoundError)
          assert.equal(err.workerEntry, 'worker/does-not-exist.js')
          assert.equal(
            err.resolvedPath,
            path.resolve(dir, 'worker/does-not-exist.js')
          )
          assert.match(err.message, /Custom worker entry not found/)
          return true
        }
      )
    })
  })

  it('throws WorkerEntryNotFoundError when workerEntry from qvac.config.json is missing', async () => {
    await withFakeSdkProject(
      async (dir) => {
        await assert.rejects(
          () => bundleSdk({ projectRoot: dir, quiet: true }),
          (err: unknown) => {
            assert.ok(err instanceof WorkerEntryNotFoundError)
            assert.equal(err.workerEntry, 'worker/index.js')
            return true
          }
        )
      },
      { workerEntry: 'worker/index.js' }
    )
  })

  it('CLI --entry takes precedence over workerEntry in config', async () => {
    await withFakeSdkProject(
      async (dir) => {
        await assert.rejects(
          () =>
            bundleSdk({
              projectRoot: dir,
              workerEntry: 'cli-entry-missing.js',
              quiet: true
            }),
          (err: unknown) => {
            assert.ok(err instanceof WorkerEntryNotFoundError)
            // Proves we used the CLI flag, not the config value.
            assert.equal(err.workerEntry, 'cli-entry-missing.js')
            assert.notEqual(err.workerEntry, 'config-entry.js')
            return true
          }
        )
      },
      { workerEntry: 'config-entry.js' }
    )
  })

  it('treats absolute workerEntry as-is (no projectRoot prefix)', async () => {
    await withFakeSdkProject(async (dir) => {
      const absMissing = path.join(dir, 'totally', 'absolute', 'path.js')
      await assert.rejects(
        () =>
          bundleSdk({
            projectRoot: dir,
            workerEntry: absMissing,
            quiet: true
          }),
        (err: unknown) => {
          assert.ok(err instanceof WorkerEntryNotFoundError)
          assert.equal(err.resolvedPath, absMissing)
          return true
        }
      )
    })
  })

  it('does not generate qvac/worker.entry.mjs when workerEntry is set', async () => {
    await withFakeSdkProject(async (dir) => {
      await assert.rejects(
        () =>
          bundleSdk({
            projectRoot: dir,
            workerEntry: 'worker/missing.js',
            quiet: true
          }),
        WorkerEntryNotFoundError
      )

      // The generated entry path must NOT exist — we should fail before writing it.
      const generated = path.join(dir, 'qvac', 'worker.entry.mjs')
      assert.equal(fs.existsSync(generated), false)
    })
  })

  it('ignores empty-string workerEntry and falls through to the default flow', async () => {
    await withFakeSdkProject(async (dir) => {
      // Empty string should NOT trigger the custom-entry branch. The bundle
      // would fail later (no bare-pack here) but it must not throw
      // WorkerEntryNotFoundError, which is what proves the branch was skipped.
      await assert.rejects(
        () => bundleSdk({ projectRoot: dir, workerEntry: '', quiet: true }),
        (err: unknown) => {
          assert.ok(!(err instanceof WorkerEntryNotFoundError))
          return true
        }
      )
    })
  })
})
