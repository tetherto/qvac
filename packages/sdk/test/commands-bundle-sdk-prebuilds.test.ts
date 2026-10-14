import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bundleSdk } from '@/commands/bundle'
import { HostPrebuildsInstallRefusedError, HostPrebuildsMissingError } from '@/utils/errors-client'
import { installFakePackageManager, withPath } from './fixtures/fake-package-manager'
import {
  RUNTIME_ADDON_ANDROID_PACKAGE,
  RUNTIME_ADDON_VERSION,
  SPLIT_ADDON,
  SPLIT_ADDON_ANDROID_PACKAGE,
  SPLIT_ADDON_VERSION,
  UNUSED_ADDON,
  bundledModules,
  createSplitAddonProject,
  type SplitAddonProjectOptions
} from './fixtures/split-addon-project'

function splitAddonProject(
  t: { after: (fn: () => void) => void },
  options: SplitAddonProjectOptions = {}
) {
  const project = createSplitAddonProject('external-sdk', options)
  t.after(project.cleanup)
  return project
}

const posixOnly = { skip: process.platform === 'win32' }

describe('bundleSdk installMissingPrebuilds', () => {
  it('leaves package.json and node_modules alone by default', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    await assert.rejects(
      withPath(pm.binDir, () =>
        bundleSdk({ projectRoot, sdkPath, configPath, hosts: ['android-arm64'], quiet: true })
      ),
      (error: unknown) =>
        error instanceof HostPrebuildsMissingError &&
        error.dependencies[SPLIT_ADDON_ANDROID_PACKAGE] === SPLIT_ADDON_VERSION,
      'without the platform package, bundling fails and the error names the pin'
    )
    assert.deepEqual(pm.calls(), [])
  })

  it('installs the missing platform package before bundling', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: ['android-arm64'],
        quiet: true,
        installMissingPrebuilds: true
      })
    )

    assert.deepEqual(pm.calls(), [
      {
        cwd: projectRoot,
        args: ['add', '--save-exact', `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`]
      }
    ])
    assert.ok(
      bundledModules(projectRoot).some((key) => key.endsWith('fake-ggml-android-arm64/index.js')),
      'the bundle resolves #host-addon to the installed platform package'
    )
    assert.deepEqual(result.addons, [SPLIT_ADDON_ANDROID_PACKAGE])
    assert.deepEqual(result.installedPrebuilds, [
      {
        name: SPLIT_ADDON_ANDROID_PACKAGE,
        version: SPLIT_ADDON_VERSION,
        addon: SPLIT_ADDON,
        hosts: ['android-arm64']
      }
    ])
  })

  it('installs only what the bundle reaches', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t, {
      withRuntime: true,
      withUnused: true
    })
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: ['android-arm64'],
        quiet: true,
        installMissingPrebuilds: true
      })
    )

    assert.deepEqual(pm.calls(), [
      {
        cwd: projectRoot,
        args: [
          'add',
          '--save-exact',
          `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`,
          `${RUNTIME_ADDON_ANDROID_PACKAGE}@${RUNTIME_ADDON_VERSION}`
        ]
      }
    ])
    assert.ok(!result.installedPrebuilds.some((pkg) => pkg.addon === UNUSED_ADDON))
  })

  it(
    'names only what the bundle reaches when platform packages are missing',
    posixOnly,
    async (t) => {
      const { projectRoot, sdkPath, configPath } = splitAddonProject(t, { withUnused: true })

      await assert.rejects(
        bundleSdk({ projectRoot, sdkPath, configPath, hosts: ['android-arm64'], quiet: true }),
        (error: unknown) =>
          error instanceof HostPrebuildsMissingError &&
          JSON.stringify(error.dependencies) ===
            JSON.stringify({ [SPLIT_ADDON_ANDROID_PACKAGE]: SPLIT_ADDON_VERSION })
      )
    }
  )

  it('installs nothing for a deferred addon', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: ['android-arm64'],
        defer: [SPLIT_ADDON],
        quiet: true,
        installMissingPrebuilds: true
      })
    )

    assert.deepEqual(pm.calls(), [])
    assert.deepEqual(result.installedPrebuilds, [])
  })

  it('refuses the install before writing anything', async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    // A second lockfile beside the fixture's pnpm one: no package manager can be chosen.
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '')

    await assert.rejects(
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: ['android-arm64'],
        quiet: true,
        installMissingPrebuilds: true
      }),
      (error: unknown) =>
        error instanceof HostPrebuildsInstallRefusedError &&
        error.dependencies[SPLIT_ADDON_ANDROID_PACKAGE] === SPLIT_ADDON_VERSION
    )

    assert.equal(fs.existsSync(path.join(projectRoot, 'qvac', 'addons.manifest.json')), false)
    assert.equal(fs.existsSync(path.join(projectRoot, 'qvac', 'worker.bundle.js')), false)
  })

  it('does not reinstall once the platform package is present', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')
    const options = {
      projectRoot,
      sdkPath,
      configPath,
      hosts: ['android-arm64'],
      quiet: true,
      installMissingPrebuilds: true
    }

    await withPath(pm.binDir, () => bundleSdk(options))
    await withPath(pm.binDir, () => bundleSdk(options))

    assert.equal(pm.calls().length, 1)
  })
})

describe('published ASR fallback mappings', () => {
  it(
    'rejects a bundle that would otherwise silently use addon-unavailable',
    posixOnly,
    async (t) => {
      const { projectRoot, sdkPath, configPath } = splitAddonProject(t, { legacyFallback: true })
      await assert.rejects(
        bundleSdk({ projectRoot, sdkPath, configPath, hosts: ['android-arm64'], quiet: true }),
        (error: unknown) =>
          error instanceof HostPrebuildsMissingError &&
          error.dependencies[SPLIT_ADDON_ANDROID_PACKAGE] === SPLIT_ADDON_VERSION
      )
    }
  )

  it('installs a published fallback mapping before bundling', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t, { legacyFallback: true })
    const pm = installFakePackageManager(projectRoot, 'pnpm')
    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: ['android-arm64'],
        quiet: true,
        installMissingPrebuilds: true
      })
    )
    assert.ok(
      bundledModules(projectRoot).some((key) => key.endsWith('fake-ggml-android-arm64/index.js'))
    )
    assert.equal(result.installedPrebuilds[0]?.name, SPLIT_ADDON_ANDROID_PACKAGE)
  })
})
