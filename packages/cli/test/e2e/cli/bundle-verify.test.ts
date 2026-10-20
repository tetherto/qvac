import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir, symlink, access, readdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli } from '../helpers/cli.js'
import { tempDir } from '../helpers/tmp.js'

// bundle sdk resolves @qvac/sdk from the project's node_modules and emits a
// worker bundle + addons manifest; verify bundle then validates that bundle for
// the host. The exhaustive option matrix lives in the SDK.
const INSTALLED_SDK = fileURLToPath(new URL('../../../node_modules/@qvac/sdk', import.meta.url))
const HOST = `${process.platform}-${process.arch}`

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// A throwaway project with the resolved SDK and its addons, and no lockfile so
// bundle cannot pick a package manager. Do not `npm install` here: that writes
// package.json / lockfile and the platform-package tests assert neither exists.
//
// Workspace `file:../sdk` nests addons under the SDK; npm `@qvac/sdk` hoists
// them next to it. Link both layouts so published e2e sees the same addons a
// user `npm install @qvac/sdk` would.
async function project(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'qvac-bundle-')
  const destScope = join(dir, 'node_modules', '@qvac')
  await mkdir(destScope, { recursive: true })
  await linkInstalledQvacScope(INSTALLED_SDK, destScope)
  return dir
}

async function linkInstalledQvacScope(sdkPath: string, destScope: string) {
  const seen = new Set<string>()
  const linkScope = async (scopeDir: string) => {
    let names: string[]
    try {
      names = await readdir(scopeDir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.') || seen.has(name)) continue
      const from = join(scopeDir, name)
      let st
      try {
        st = await lstat(from)
      } catch {
        continue
      }
      if (!st.isDirectory() && !st.isSymbolicLink()) continue
      seen.add(name)
      await symlink(from, join(destScope, name))
    }
  }

  await linkScope(join(sdkPath, '..'))
  await linkScope(join(await realpath(sdkPath), 'node_modules', '@qvac'))
}

describe('cli: bundle sdk → verify bundle (chain)', () => {
  it('bundles the SDK worker, then verifies the produced bundle', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(['bundle', 'sdk', '--host', HOST, '-q'], {
      cwd: dir,
      timeoutMs: 300_000
    })
    assert.equal(bundle.code, 0, `bundle sdk failed:\n${bundle.output}`)
    assert.ok(await exists(join(dir, 'qvac', 'worker.bundle.js')), 'expected qvac/worker.bundle.js')
    assert.ok(
      await exists(join(dir, 'qvac', 'addons.manifest.json')),
      'expected qvac/addons.manifest.json'
    )

    const verify = await runCli(
      [
        'verify',
        'bundle',
        '--addons-source',
        join(dir, 'qvac', 'worker.bundle.js'),
        '--host',
        HOST
      ],
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
  it('names the platform packages it cannot install and fails without them', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(['bundle', 'sdk', '--host', 'android-arm64'], {
      cwd: dir,
      timeoutMs: 300_000
    })

    assert.notEqual(bundle.code, 0, 'a split addon cannot bundle without its platform package')
    assert.match(bundle.output, /Cannot install the addon platform packages automatically/)
    assert.match(bundle.output, /Bundling without installing them/)
    assert.match(bundle.output, /HOST_PREBUILDS_MISSING|needs each mobile host's platform package/)
    assert.match(bundle.output, /"@qvac\/tts-ggml-android-arm64": "\d+\.\d+\.\d+"/)
    assert.ok(!(await exists(join(dir, 'package.json'))), 'package.json must not be created')
  })

  it('skips the install with --no-install and names the pins to add', async (t) => {
    const dir = await project(t)

    const bundle = await runCli(['bundle', 'sdk', '--host', 'android-arm64', '--no-install'], {
      cwd: dir,
      timeoutMs: 300_000
    })

    assert.notEqual(bundle.code, 0)
    assert.doesNotMatch(bundle.output, /Cannot install the addon platform packages/)
    assert.match(bundle.output, /"@qvac\/tts-ggml-android-arm64": "\d+\.\d+\.\d+"/)
  })
})
