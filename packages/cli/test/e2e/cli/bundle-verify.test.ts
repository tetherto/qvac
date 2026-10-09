import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdir, symlink, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runCli } from '../helpers/cli.js'
import { tempDir } from '../helpers/tmp.js'

// bundle sdk resolves @qvac/sdk from the project's node_modules and emits a
// worker bundle + addons manifest; verify bundle then validates that bundle for
// the host. The exhaustive option matrix lives in the SDK.
const INSTALLED_SDK = fileURLToPath(new URL('../../../node_modules/@qvac/sdk', import.meta.url))
const HOST = `${process.platform}-${process.arch}`
const DESKTOP_BUNDLE = join('qvac', 'worker', 'index.bundle')
const PHONE_BUNDLE = join('qvac', 'worker', 'index.bundle.mjs')

// The bundle's entry imports these from the project root, where an install hoists them.
const HOISTED = ['bare-stow', 'bare-stow-target-react-native']

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// A throwaway project with @qvac/sdk installed, the way a user's project looks.
async function project(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'qvac-bundle-')
  await mkdir(join(dir, 'node_modules', '@qvac'), { recursive: true })
  await symlink(INSTALLED_SDK, join(dir, 'node_modules', '@qvac', 'sdk'))
  const sdkRequire = createRequire(join(INSTALLED_SDK, 'package.json'))
  for (const name of HOISTED) {
    await symlink(dirname(sdkRequire.resolve(`${name}/package`)), join(dir, 'node_modules', name))
  }
  return dir
}

describe('cli: bundle sdk → verify bundle (chain)', () => {
  it('bundles the SDK worker, then verifies the produced bundle', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(['bundle', 'sdk', '--host', HOST, '-q'], {
      cwd: dir,
      timeoutMs: 300_000
    })
    assert.equal(bundle.code, 0, `bundle sdk failed:\n${bundle.output}`)
    assert.ok(await exists(join(dir, DESKTOP_BUNDLE)), `expected ${DESKTOP_BUNDLE}`)
    assert.ok(
      await exists(join(dir, 'qvac', 'addons.manifest.json')),
      'expected qvac/addons.manifest.json'
    )

    const verify = await runCli(
      ['verify', 'bundle', '--addons-source', join(dir, DESKTOP_BUNDLE), '--host', HOST],
      { cwd: dir, timeoutMs: 120_000 }
    )
    assert.equal(verify.code, 0, `verify bundle failed:\n${verify.output}`)
    // "passed" when strict ABI ran; otherwise it reports the packages it checked
    // with ABI skipped (Bare runtime version not auto-detected on this host).
    assert.match(verify.output, /verification passed|ABI checks skipped for \d+ packages?/)
  })
})

describe('cli: bundle sdk addon platform packages', () => {
  // The throwaway project has no lockfile, so no package manager can be
  // chosen and nothing is installed.
  it('names the platform packages it cannot install and still bundles', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(
      ['bundle', 'sdk', '--target', 'react-native', '--host', 'android-arm64'],
      { cwd: dir, timeoutMs: 300_000 }
    )

    assert.equal(bundle.code, 0, `bundle sdk failed:\n${bundle.output}`)
    assert.match(bundle.output, /Cannot install the addon platform packages automatically/)
    assert.match(bundle.output, /"@qvac\/tts-ggml-android-arm64": "\d+\.\d+\.\d+"/)
    assert.match(bundle.output, /Bundled without installing them/)
    assert.doesNotMatch(bundle.output, /Bundling again/, 'a refused install bundles once')
    assert.ok(await exists(join(dir, PHONE_BUNDLE)), `expected ${PHONE_BUNDLE}`)
    assert.ok(
      await exists(join(dir, 'qvac', 'addons.manifest.json')),
      'expected qvac/addons.manifest.json'
    )
    assert.ok(!(await exists(join(dir, 'package.json'))), 'package.json must not be created')
  })

  it('skips the install with --no-install', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(
      ['bundle', 'sdk', '--target', 'react-native', '--host', 'android-arm64', '--no-install'],
      { cwd: dir, timeoutMs: 300_000 }
    )

    assert.equal(bundle.code, 0, `bundle sdk failed:\n${bundle.output}`)
    assert.doesNotMatch(bundle.output, /addon platform packages/)
    assert.ok(await exists(join(dir, PHONE_BUNDLE)), `expected ${PHONE_BUNDLE}`)
  })
})
