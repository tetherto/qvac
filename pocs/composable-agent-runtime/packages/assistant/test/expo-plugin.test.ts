import {
  compileModsAsync,
  withDangerousMod
} from '@expo/config-plugins'
import type { ExpoConfig } from '@expo/config-types'
import { composeHarnessContribution } from '@qvac/harness/expo-plugin'
import { buildHarnessReactNativeBundle } from '@qvac/harness/react-native-stow'
import { composeSyncContribution } from '@qvac/sync/expo-plugin'
import { buildSyncReactNativeBundle } from '@qvac/sync/worker'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  composeAssistantStack,
  createAssistantExpoPlugin
} from '../expo-plugin.ts'
import type { PackageContribution } from '../lib/expo/types.ts'

const temporaryPaths: string[] = []
const pocsRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const requiredHosts = [
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
] as const

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
  it('runs real expo order as sync -> harness -> sdk -> finalizer', async () => {
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
      syncBuild: async () => {
        events.push('sync')
        return builtWorker('sync', projectRoot, ['@qvac/sync-addon'], {
          packages: [
            {
              name: '@qvac/sync-addon',
              version: '2.0.0',
              packagePath: 'bundle:sync/@qvac/sync-addon',
              singleton: true
            }
          ]
        })
      },
      harnessBuild: async () => {
        events.push('harness')
        return builtWorker('harness', projectRoot)
      },
      sdkPlugin(config) {
        return withDangerousMod(config, [
          'android',
          async (context) => {
            events.push('sdk')
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

    expect(events).toEqual(['sync', 'harness', 'sdk'])
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
    const stackManifest = await readJson<{ pluginExecutionOrder: string[] }>(
      path.join(projectRoot, 'qvac', 'assistant-stack.manifest.json')
    )
    expect(stackManifest.pluginExecutionOrder).toEqual([
      'sync-contributor-plugin',
      'harness-contributor-plugin',
      'invoke-sdk-expo-plugin',
      'finalize-assistant-stack'
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
      syncBuild: async () => {
        syncBuildAttempts += 1
        if (syncBuildAttempts === 1) {
          throw new Error('expected first build failure')
        }
        return builtWorker('sync', projectRoot)
      },
      harnessBuild: async () => builtWorker('harness', projectRoot),
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

  it('fails on duplicate sdk/sync/harness plugin registration string forms', async () => {
    const plugin = createAssistantExpoPlugin({
      syncBuild: async () => {
        throw new Error('unused')
      },
      harnessBuild: async () => {
        throw new Error('unused')
      }
    })

    expect(() =>
      plugin(
        createExpoConfig('/tmp/assistant', [
          '@qvac/sdk/expo-plugin',
          ['../../node_modules/@qvac/sdk/expo-plugin', {}]
        ]),
        undefined
      )
    ).toThrow(/duplicate sdk plugin registration/i)

    expect(() =>
      plugin(createExpoConfig('/tmp/assistant', ['@qvac/sync/expo-plugin']), undefined)
    ).toThrow(/duplicate sync plugin registration/i)

    expect(() =>
      plugin(createExpoConfig('/tmp/assistant', ['@qvac/harness/expo-plugin']), undefined)
    ).toThrow(/duplicate harness plugin registration/i)
  })

  it('resolves contribution native addons through stack finalization', async () => {
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

    const syncBuild = await builtWorker('sync', projectRoot, [
      'linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0'
    ])
    await composeSyncContribution(projectRoot, syncBuild, { packageVersion: '1.0.0' })
    await composeHarnessContribution(
      projectRoot,
      await builtWorker('harness', projectRoot),
      { packageVersion: '1.0.0' }
    )

    await composeAssistantStack({ projectRoot })
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

    await writeContributions(projectRoot, {
      syncAddons: ['@qvac/shared-addon', '@qvac/sync-addon'],
      syncPackages: [
        {
          name: '@qvac/shared-addon',
          version: '1.0.0',
          packagePath: 'bundle:sync/@qvac/shared-addon',
          singleton: true
        },
        {
          name: '@qvac/sync-addon',
          version: '2.0.0',
          packagePath: 'bundle:sync/@qvac/sync-addon',
          singleton: true
        }
      ]
    })
    await composeAssistantStack({ projectRoot })

    await writeContributions(projectRoot)
    await composeAssistantStack({ projectRoot })

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

    await writeContributions(projectRoot, {
      syncAddons: ['@qvac/shared-addon', '@qvac/sync-addon'],
      syncPackages: [
        {
          name: '@qvac/shared-addon',
          version: '1.0.0',
          packagePath: 'bundle:sync/@qvac/shared-addon',
          singleton: true
        },
        {
          name: '@qvac/sync-addon',
          version: '2.0.0',
          packagePath: 'bundle:sync/@qvac/sync-addon',
          singleton: true
        }
      ]
    })
    await composeAssistantStack({ projectRoot })

    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle-v2',
      addons: ['@qvac/sdk-addon-v2', '@qvac/shared-addon']
    })

    await writeContributions(projectRoot, {
      syncAddons: ['@qvac/shared-addon', '@qvac/sync-addon'],
      syncPackages: [
        {
          name: '@qvac/shared-addon',
          version: '1.0.0',
          packagePath: 'bundle:sync/@qvac/shared-addon',
          singleton: true
        },
        {
          name: '@qvac/sync-addon',
          version: '2.0.0',
          packagePath: 'bundle:sync/@qvac/sync-addon',
          singleton: true
        }
      ]
    })
    await composeAssistantStack({ projectRoot })

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

    await composeSyncContribution(projectRoot, syncBuild, { packageVersion: '0.0.0-poc' })
    await composeHarnessContribution(projectRoot, harnessBuild, { packageVersion: '0.0.0-poc' })
    await composeAssistantStack({ projectRoot })
    const stackManifest = await readJson<{
      mergedAddons: Array<{ name: string; version: string }>
    }>(path.join(projectRoot, 'qvac', 'assistant-stack.manifest.json'))
    const bareSignals = stackManifest.mergedAddons.filter((entry) => entry.name === 'bare-signals')
    expect(bareSignals).toHaveLength(1)
    expect(bareSignals[0]?.name).toBe('bare-signals')
    expect(typeof bareSignals[0]?.version).toBe('string')
  })

  it('fails closed when sdk manifest is missing', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-missing-sdk-manifest-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writeContributions(projectRoot)

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /missing sdk addons manifest/i
    )
  })

  it('fails closed when sync contribution is missing', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-missing-sync-contribution-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot, { skipSync: true })

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /missing sync contribution/i
    )
  })

  it('fails closed when contribution json is malformed', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-malformed-contribution-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot)
    await writeFile(
      path.join(projectRoot, 'qvac', 'contributions', 'sync.json'),
      '{"schemaVersion":1,,}\n'
    )

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /malformed sync contribution json/i
    )
  })

  it('fails closed when sdk manifest json is malformed', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-malformed-sdk-json-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await mkdir(path.join(projectRoot, 'qvac'), { recursive: true })
    await writeFile(path.join(projectRoot, 'qvac', 'addons.manifest.json'), '{"version":1,,}\n')
    await writeContributions(projectRoot)

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /malformed sdk addons manifest json/i
    )
  })

  it('fails closed on protocol mismatch in contribution', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-protocol-mismatch-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot)
    const syncPath = path.join(projectRoot, 'qvac', 'contributions', 'sync.json')
    const sync = await readJson<PackageContribution>(syncPath)
    await writeJson(syncPath, { ...sync, protocolVersion: 99 })

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(/protocol mismatch/i)
  })

  it('fails closed on insufficient host coverage in contribution', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-insufficient-hosts-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot)
    const syncPath = path.join(projectRoot, 'qvac', 'contributions', 'sync.json')
    const sync = await readJson<PackageContribution>(syncPath)
    await writeJson(syncPath, { ...sync, hosts: ['android-arm64'] })

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(/host mismatch/i)
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
    await writeContributions(projectRoot)

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /unable to resolve required package version/i
    )
  })

  it('fails closed on conflicting native addon versions', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-conflicting-native-versions-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writePackageJson(projectRoot, '@qvac/demo', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot, {
      syncAddons: ['@qvac/demo'],
      syncPackages: [
        {
          name: '@qvac/demo',
          version: '1.0.0',
          packagePath: 'bundle:sync/@qvac/demo',
          singleton: true
        }
      ],
      harnessAddons: ['@qvac/demo'],
      harnessPackages: [
        {
          name: '@qvac/demo',
          version: '2.0.0',
          packagePath: 'bundle:harness/@qvac/demo',
          singleton: true
        }
      ],
      harnessAddonVersions: { '@qvac/demo': '2.0.0' }
    })

    await expect(composeAssistantStack({ projectRoot })).rejects.toThrow(
      /conflicting versions for native addon @qvac\/demo/i
    )
  })

  it('fails closed when BareKit linker project-root declaration is missing', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-linker-failure-'))
    temporaryPaths.push(projectRoot)
    await seedRequiredPackages(projectRoot, ['@qvac/sync', '@qvac/harness', '@qvac/sdk'])
    await writePackageJson(projectRoot, '@qvac/sdk-addon', '1.0.0')
    await writeJson(path.join(projectRoot, 'qvac', 'addons.manifest.json'), {
      version: 1,
      bundleId: 'sdk-bundle',
      addons: ['@qvac/sdk-addon']
    })
    await writeContributions(projectRoot)
    const bareKitRoot = path.join(projectRoot, 'node_modules', 'react-native-bare-kit')
    await mkdir(path.join(bareKitRoot, 'android'), { recursive: true })
    await mkdir(path.join(bareKitRoot, 'ios'), { recursive: true })
    await writeJson(path.join(bareKitRoot, 'package.json'), {
      name: 'react-native-bare-kit',
      version: '0.14.0'
    })
    await writeFile(path.join(bareKitRoot, 'android', 'link.mjs'), 'export {}\n')
    await writeFile(path.join(bareKitRoot, 'ios', 'link.mjs'), 'export {}\n')

    await expect(composeAssistantStack({ projectRoot, pinLinkerRoot: true })).rejects.toThrow(
      /barekit linker project-root declaration was not found/i
    )
  })
})

interface WorkerOverrides {
  readonly hosts?: readonly string[]
  readonly bundleId?: string
  readonly packages?: PackageContribution['packages']
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
  const hosts = overrides.hosts ?? [...requiredHosts]
  const bundleId = overrides.bundleId ?? `${role}-bundle`
  await writeJson(metadataPath, {
    bundleId,
    contract: role === 'sync' ? 'qvac.sync' : 'qvac.harness',
    protocolVersion: 1,
    hosts,
    nativeAddons,
    packages: overrides.packages
  })
  return {
    descriptor: {
      entryPath: path.join(projectRoot, `${role}-entry.ts`),
      harnessPath,
      metadataPath,
      contract: role === 'sync' ? ('qvac.sync' as const) : ('qvac.harness' as const),
      protocolVersion: 1 as const,
      hosts
    },
    bundlePath,
    metadata: {
      bundleId,
      contract: role === 'sync' ? ('qvac.sync' as const) : ('qvac.harness' as const),
      protocolVersion: 1 as const,
      hosts,
      nativeAddons: [...nativeAddons],
      packages: overrides.packages
    }
  }
}

async function writeContributions(
  projectRoot: string,
  options: {
    readonly skipSync?: boolean
    readonly skipHarness?: boolean
    readonly syncAddons?: readonly string[]
    readonly harnessAddons?: readonly string[]
    readonly syncPackages?: PackageContribution['packages']
    readonly harnessPackages?: PackageContribution['packages']
    readonly harnessAddonVersions?: Readonly<Record<string, string>>
  } = {}
) {
  if (!options.skipSync) {
    const syncAddons = options.syncAddons ?? []
    if (syncAddons.some((entry) => entry.startsWith('linked:'))) {
      await composeSyncContribution(
        projectRoot,
        await builtWorker('sync', projectRoot, syncAddons, {
          packages: options.syncPackages
        }),
        { packageVersion: '1.0.0' }
      )
    } else {
      await writeNormalizedContribution(
        projectRoot,
        'sync',
        syncAddons,
        options.syncPackages,
        Object.fromEntries(
          (options.syncPackages ?? []).map((entry) => [entry.name, entry.version])
        )
      )
    }
  }
  if (!options.skipHarness) {
    await writeNormalizedContribution(
      projectRoot,
      'harness',
      options.harnessAddons ?? [],
      options.harnessPackages,
      {
        ...Object.fromEntries(
          (options.harnessPackages ?? []).map((entry) => [entry.name, entry.version])
        ),
        ...(options.harnessAddonVersions ?? {})
      }
    )
  }
}

async function writeNormalizedContribution(
  projectRoot: string,
  role: 'sync' | 'harness',
  addonNames: readonly string[],
  packages: PackageContribution['packages'] | undefined,
  versions: Readonly<Record<string, string>> = {}
) {
  const generatedRoot = path.join(projectRoot, '.generated', role)
  const harnessPath = path.join(generatedRoot, `${role}.js`)
  const metadataPath = path.join(generatedRoot, `${role}.metadata.json`)
  const bundlePath = path.join(generatedRoot, `${role}.bundle.mjs`)
  await mkdir(generatedRoot, { recursive: true })
  await writeFile(harnessPath, `export default '${role}';\n`)
  await writeFile(bundlePath, `export default '${role}-bundle';\n`)
  await writeJson(metadataPath, { placeholder: true })
  const nativeAddons = addonNames.map((name) => ({
    name,
    version: versions[name] ?? '1.0.0'
  }))
  // Keep packages aligned with native addon versions to avoid singleton conflicts.
  const alignedPackages =
    packages ??
    nativeAddons.map((addon) => ({
      name: addon.name,
      version: addon.version,
      packagePath: `bundle:${role}-bundle/${addon.name}`,
      singleton: true
    }))
  const contribution: PackageContribution = {
    schemaVersion: 1,
    packageName: role === 'sync' ? '@qvac/sync' : '@qvac/harness',
    packageVersion: '1.0.0',
    contract: role === 'sync' ? 'qvac.sync' : 'qvac.harness',
    protocolVersion: 1,
    bundleId: `${role}-bundle`,
    hosts: [...requiredHosts],
    nativeAddons,
    packages: alignedPackages,
    harnessPath,
    metadataPath,
    bundlePath
  }
  await writeJson(path.join(projectRoot, 'qvac', 'contributions', `${role}.json`), contribution)
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
