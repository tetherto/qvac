import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bundleSdk } from '@/commands/bundle'
import { HostPrebuildsInstallRefusedError } from '@/utils/errors-client'
import { installFakePackageManager, withPath } from './fixtures/fake-package-manager'
import {
  SPLIT_ADDON,
  SPLIT_ADDON_ANDROID_PACKAGE,
  SPLIT_ADDON_VERSION,
  bundledModules,
  createSplitAddonProject
} from './fixtures/split-addon-project'

function splitAddonProject(t: { after: (fn: () => void) => void }) {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.after(project.cleanup)
  return project
}

const posixOnly = { skip: process.platform === 'win32' }

describe('bundleSdk installMissingPrebuilds', () => {
  it('leaves package.json and node_modules alone by default', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        target: 'react-native',
        hosts: ['android-arm64'],
        quiet: true
      })
    )

    assert.deepEqual(pm.calls(), [])
    assert.deepEqual(result.installedPrebuilds, [])
    assert.ok(
      (await bundledModules(projectRoot)).some((key) =>
        key.endsWith('fake-ggml/addon-unavailable.js')
      ),
      'without the platform package, #host-addon resolves to the fallback'
    )
  })

  it('installs the missing platform package and bundles again', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')

    const result = await withPath(pm.binDir, () =>
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        target: 'react-native',
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
      (await bundledModules(projectRoot)).some((key) =>
        key.endsWith('fake-ggml-android-arm64/index.js')
      ),
      'the second bundle resolves #host-addon to the installed platform package'
    )
    assert.deepEqual(result.addons, [SPLIT_ADDON])
    assert.deepEqual(result.installedPrebuilds, [
      {
        name: SPLIT_ADDON_ANDROID_PACKAGE,
        version: SPLIT_ADDON_VERSION,
        addon: SPLIT_ADDON,
        hosts: ['android-arm64']
      }
    ])
  })

  it('writes the bundle and manifest before refusing the install', async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    // A second lockfile beside the fixture's pnpm one: no package manager can be chosen.
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '')

    await assert.rejects(
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        target: 'react-native',
        hosts: ['android-arm64'],
        quiet: true,
        installMissingPrebuilds: true
      }),
      (error: unknown) =>
        error instanceof HostPrebuildsInstallRefusedError &&
        error.dependencies[SPLIT_ADDON_ANDROID_PACKAGE] === SPLIT_ADDON_VERSION
    )

    assert.ok(
      (await bundledModules(projectRoot)).some((key) =>
        key.endsWith('fake-ggml/addon-unavailable.js')
      )
    )
  })

  it('does not reinstall once the platform package is present', posixOnly, async (t) => {
    const { projectRoot, sdkPath, configPath } = splitAddonProject(t)
    const pm = installFakePackageManager(projectRoot, 'pnpm')
    const options = {
      projectRoot,
      sdkPath,
      configPath,
      target: 'react-native',
      hosts: ['android-arm64'],
      quiet: true,
      installMissingPrebuilds: true
    }

    await withPath(pm.binDir, () => bundleSdk(options))
    await withPath(pm.binDir, () => bundleSdk(options))

    assert.equal(pm.calls().length, 1)
  })
})
