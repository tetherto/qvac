import {
  compileModsAsync,
  withDangerousMod
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { buildHarnessReactNativeBundle } from '@qvac/harness/react-native-stow'
import { buildSyncReactNativeBundle } from '@qvac/sync/react-native-stow'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  composeAssistantStack,
  createAssistantExpoPlugin
} from '../expo-plugin.ts'

const temporaryPaths: string[] = []
const pocsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

interface ExpoConfigForTests extends ExpoConfig {
  readonly _internal: {
    readonly projectRoot: string
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => rm(entry, { force: true, recursive: true }))
  )
})

describe('assistant expo plugin composition', () => {
  it('runs real expo order as build -> sdk write -> merge', async () => {
    const events: string[] = []
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-expo-order-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/sync-addon', '2.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'bootstrap',
      addons: []
    })

    const plugin = createAssistantExpoPlugin({
      buildSync: async () => {
        events.push('build-sync')
        return builtWorker('sync', projectRoot, ['@qvac/sync-addon'])
      },
      buildHarness: async () => {
        events.push('build-harness')
        return builtWorker('harness', projectRoot)
      },
      sdkPlugin(config) {
        return withDangerousMod(config, [
          'android',
          async (context) => {
            events.push('sdk-write')
            await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
              version: 1,
              bundleId: 'sdk-bundle',
              addons: ['@qvac/sdk-addon']
            })
            return context
          }
        ])
      }
    })

    const configured = plugin(createExpoConfig(projectRoot, []), undefined)
    await compileModsAsync(configured, {
      projectRoot,
      platforms: ['android'],
      introspect: false,
      assertMissingModProviders: false,
      ignoreExistingNativeFiles: true
    })

    expect(events).toEqual(['build-sync', 'build-harness', 'sdk-write'])
    const mergedManifest = await readJson<{
      addons: string[]
      assistantProvenance: {
        sdkSourceAddons: Array<{ name: string; version: string }>
      }
    }>(path.join(projectRoot, 'qvac', 'addons.manifest.json'))
    expect(mergedManifest.addons).toEqual(['@qvac/sdk-addon', '@qvac/sync-addon'])
    expect(mergedManifest.assistantProvenance.sdkSourceAddons).toEqual([
      { name: '@qvac/sdk-addon', version: '1.0.0' }
    ])
  })

  it('builds workers once and clears stale failed cache entries', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-expo-cache-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    let syncBuildAttempts = 0
    const plugin = createAssistantExpoPlugin({
      buildSync: async () => {
        syncBuildAttempts += 1
        if (syncBuildAttempts === 1) {
          throw new Error('expected first build failure')
        }
        return builtWorker('sync', projectRoot)
      },
      buildHarness: async () => builtWorker('harness', projectRoot),
      sdkPlugin(config) {
        return config
      }
    })

    await expect(
      compileModsAsync(plugin(createExpoConfig(projectRoot, []), undefined), {
        projectRoot,
        platforms: ['android'],
        introspect: false,
        assertMissingModProviders: false,
        ignoreExistingNativeFiles: true
      })
    ).rejects.toThrow(/expected first build failure/i)

    await compileModsAsync(plugin(createExpoConfig(projectRoot, []), undefined), {
      projectRoot,
      platforms: ['android'],
      introspect: false,
      assertMissingModProviders: false,
      ignoreExistingNativeFiles: true
    })
    expect(syncBuildAttempts).toBe(2)
  })

  it('fails on duplicate sdk plugin registration string forms', async () => {
    const plugin = createAssistantExpoPlugin({
      buildSync: async () => {
        throw new Error('unused')
      },
      buildHarness: async () => {
        throw new Error('unused')
      }
    })

    expect(() =>
      plugin(createExpoConfig('/tmp/assistant', [
        '@qvac/sdk/expo-plugin',
        ['../../node_modules/@qvac/sdk/expo-plugin', {}]
      ]), undefined)
    ).toThrow(/duplicate sdk plugin registration/i)
  })

  it('resolves linked version from package tree not top-level', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-linked-tree-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/demo', '2.0.0')
    await writePackageJson(
      path.join(projectRoot, 'node_modules', '@qvac', 'holder'),
      '@qvac/demo',
      '1.0.0',
      'node_modules'
    )
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () =>
        builtWorker('sync', projectRoot, ['linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0']),
      buildHarness: async () => builtWorker('harness', projectRoot)
    })
    const stackManifest = await readJson<{
      workers: {
        sync: {
          nativeAddons: Array<{ name: string; version: string }>
        }
      }
    }>(path.join(projectRoot, 'qvac', 'assistant-stack.manifest.json'))
    expect(stackManifest.workers.sync.nativeAddons).toEqual([
      { name: '@qvac/demo', version: '1.0.0' }
    ])
  })

  it('writes explicit sdk provenance marker and preserves on direct repeat', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-provenance-repeat-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/shared-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/sync-addon', '2.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon', '@qvac/shared-addon']
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () =>
        builtWorker('sync', projectRoot, ['@qvac/shared-addon', '@qvac/sync-addon']),
      buildHarness: async () => builtWorker('harness', projectRoot)
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () => builtWorker('sync', projectRoot),
      buildHarness: async () => builtWorker('harness', projectRoot)
    })

    const manifest = await readJson<{
      addons: string[]
      assistantProvenance: {
        sdkSourceAddons: Array<{ name: string; version: string }>
      }
    }>(path.join(projectRoot, 'qvac', 'addons.manifest.json'))
    expect(manifest.addons).toEqual(['@qvac/sdk-addon', '@qvac/shared-addon'])
    expect(manifest.assistantProvenance.sdkSourceAddons).toEqual([
      { name: '@qvac/sdk-addon', version: '1.0.0' },
      { name: '@qvac/shared-addon', version: '1.0.0' }
    ])
  })

  it('clears provenance marker when sdk rewrites then remixes overlap', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-provenance-refresh-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon-v1', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/sdk-addon-v2', '2.0.0')
    await writePackageJson(projectRoot, '@qvac/shared-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/sync-addon', '2.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle-v1',
      addons: ['@qvac/sdk-addon-v1', '@qvac/shared-addon']
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () =>
        builtWorker('sync', projectRoot, ['@qvac/shared-addon', '@qvac/sync-addon']),
      buildHarness: async () => builtWorker('harness', projectRoot)
    })

    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle-v2',
      addons: ['@qvac/sdk-addon-v2', '@qvac/shared-addon']
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () =>
        builtWorker('sync', projectRoot, ['@qvac/shared-addon', '@qvac/sync-addon']),
      buildHarness: async () => builtWorker('harness', projectRoot)
    })

    const manifest = await readJson<{
      addons: string[]
      assistantProvenance: {
        sdkSourceAddons: Array<{ name: string; version: string }>
      }
    }>(path.join(projectRoot, 'qvac', 'addons.manifest.json'))
    expect(manifest.addons).toEqual([
      '@qvac/sdk-addon-v2',
      '@qvac/shared-addon',
      '@qvac/sync-addon'
    ])
    expect(manifest.assistantProvenance.sdkSourceAddons).toEqual([
      { name: '@qvac/sdk-addon-v2', version: '2.0.0' },
      { name: '@qvac/shared-addon', version: '1.0.0' }
    ])
  })

  it('real builder-to-composer integration has no bare-signals split versions', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-real-builder-'))
    temporaryPaths.push(projectRoot)
    await mkdir(path.join(projectRoot, 'qvac'), { recursive: true })
    await symlink(path.join(pocsRoot, 'node_modules'), path.join(projectRoot, 'node_modules'))
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk']
    })

    const syncBuild = await buildSyncReactNativeBundle({
      outputDirectory: path.join(projectRoot, '.generated', 'sync')
    })
    const harnessBuild = await buildHarnessReactNativeBundle({
      outputDirectory: path.join(projectRoot, '.generated', 'harness')
    })

    await composeAssistantStack({
      projectRoot,
      buildSync: async () => syncBuild,
      buildHarness: async () => harnessBuild
    })
    const stackManifest = await readJson<{
      mergedAddons: Array<{ name: string; version: string }>
    }>(path.join(projectRoot, 'qvac', 'assistant-stack.manifest.json'))
    const bareSignals = stackManifest.mergedAddons.filter((entry) => entry.name === 'bare-signals')
    expect(bareSignals).toEqual([{ name: 'bare-signals', version: '5.0.0' }])
  })

  it('fails closed when sdk manifest is missing', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-missing-sdk-manifest-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () => builtWorker('sync', projectRoot),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/missing sdk addons manifest/i)
  })

  it('fails closed when sdk manifest json is malformed', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-malformed-sdk-json-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await mkdir(path.join(projectRoot, 'qvac'), { recursive: true })
    await writeFile(path.join(projectRoot, 'qvac', 'addons.manifest.json'), '{"version":1,,}\n')

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () => builtWorker('sync', projectRoot),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/malformed sdk addons manifest json/i)
  })

  it('fails closed when worker artifacts are missing', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-missing-worker-artifacts-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () => {
          const buildResult = await builtWorker('sync', projectRoot)
          await unlink(buildResult.bundlePath)
          return buildResult
        },
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/missing worker artifact/i)
  })

  it('fails closed on insufficient host coverage in worker metadata', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-insufficient-hosts-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () =>
          builtWorker('sync', projectRoot, [], { hosts: ['android-arm64'] }),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/malformed worker metadata/i)
  })

  it('fails closed when sdk addon cannot be resolved', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-unresolvable-sdk-addon-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/missing-addon']
    })

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () => builtWorker('sync', projectRoot),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/unable to resolve required package version/i)
  })

  it('fails closed when linked version is absent from package tree', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-missing-linked-version-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/demo', '2.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () =>
          builtWorker('sync', projectRoot, [
            'linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0'
          ]),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/unable to resolve required package version/i)
  })

  it('fails closed on conflicting native addon versions', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-conflicting-native-versions-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/demo', '2.0.0')
    await writePackageJson(
      path.join(projectRoot, 'node_modules', '@qvac', 'holder'),
      '@qvac/demo',
      '1.0.0',
      'node_modules'
    )
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })

    await expect(
      composeAssistantStack({
        projectRoot,
        buildSync: async () =>
          builtWorker('sync', projectRoot, [
            'linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0',
            'linked:qvac__demo.2.0.0.framework/qvac__demo.2.0.0'
          ]),
        buildHarness: async () => builtWorker('harness', projectRoot)
      })
    ).rejects.toThrow(/conflicting versions for native addon @qvac\/demo/i)
  })
})

interface WorkerOverrides {
  readonly hosts?: readonly string[]
  readonly bundleId?: string
}

async function builtWorker(
  role: 'sync' | 'harness',
  projectRoot: string,
  nativeAddons: readonly string[] = [],
  overrides: WorkerOverrides = {}
) {
  const generatedRoot = path.join(projectRoot, '.generated', role)
  const harnessPath = path.join(generatedRoot, `${role}.js`)
  const metadataPath = path.join(generatedRoot, `${role}.metadata.json`)
  const bundlePath = path.join(generatedRoot, `${role}.bundle.mjs`)
  await mkdir(generatedRoot, { recursive: true })
  await writeFile(harnessPath, `export default '${role}';\n`)
  await writeFile(bundlePath, `export default '${role}-bundle';\n`)
  const hosts = overrides.hosts ?? [
    'android-arm64',
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator'
  ]
  const bundleId = overrides.bundleId ?? `${role}-bundle`
  await writeJson(metadataPath, {
    bundleId,
    contract: role === 'sync' ? 'qvac.sync' : 'qvac.harness',
    protocolVersion: 1,
    hosts,
    nativeAddons
  })
  return {
    descriptor: {
      entryPath: path.join(projectRoot, `${role}-entry.ts`),
      harnessPath,
      metadataPath,
      contract: role === 'sync' ? 'qvac.sync' : 'qvac.harness',
      protocolVersion: 1 as const,
      hosts
    },
    bundlePath,
    metadata: {
      bundleId,
      contract: role === 'sync' ? ('qvac.sync' as const) : ('qvac.harness' as const),
      protocolVersion: 1 as const,
      hosts,
      nativeAddons: [...nativeAddons]
    }
  }
}

async function writePackageJson(
  projectRoot: string,
  packageName: string,
  version: string,
  prefix = 'node_modules'
) {
  const packageDirectory = path.join(
    projectRoot,
    ...(prefix.length > 0 ? [prefix] : []),
    ...packageName.split('/')
  )
  await mkdir(packageDirectory, { recursive: true })
  await writeJson(path.join(packageDirectory, 'package.json'), {
    name: packageName,
    version
  })
}

async function seedRequiredPackages(projectRoot: string, packageNames: readonly string[]) {
  for (const packageName of new Set(['@qvac/assistant', ...packageNames])) {
    await writePackageJson(projectRoot, packageName, '1.0.0', 'node_modules')
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function createExpoConfig(
  projectRoot: string,
  plugins: NonNullable<ExpoConfig['plugins']>
): ExpoConfigForTests {
  return {
    name: 'assistant-app',
    slug: 'assistant-app',
    plugins: [...plugins],
    _internal: {
      projectRoot
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const source = await readFile(filePath, 'utf8')
  return JSON.parse(source) as T
}
