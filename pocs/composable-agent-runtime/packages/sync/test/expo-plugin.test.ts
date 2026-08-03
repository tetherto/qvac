import test from 'brittle'
import { compileModsAsync } from '@expo/config-plugins'
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  composeSyncContribution,
  createSyncExpoPlugin
} from '../expo-plugin.ts'
import { validateStandaloneContribution } from '../lib/expo/finalize.ts'

const temporaryPaths: string[] = []
const requiredHosts = ['android-arm64', 'ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']

test('sync contributor writes contribution without standalone manifest', async (t) => {
  const projectRoot = await createProject()
  await writePackage(projectRoot, '@qvac/sync-addon', '1.0.0')
  const build = await createBuild(projectRoot, ['@qvac/sync-addon'], {
    packages: [
      {
        name: '@qvac/sync-addon',
        version: '1.0.0',
        packagePath: 'node_modules/@qvac/sync-addon/package.json',
        singleton: true
      }
    ]
  })
  const plugin = createSyncExpoPlugin({
    mode: 'contributor',
    build: async () => build,
    packageVersion: '1.2.3'
  })

  await compile(plugin, projectRoot)

  const contribution = await readJson(path.join(projectRoot, 'qvac/contributions/sync.json'))
  t.is(contribution.packageVersion, '1.2.3')
  t.alike(contribution.nativeAddons, [{ name: '@qvac/sync-addon', version: '1.0.0' }])
  await t.exception(readFile(path.join(projectRoot, 'qvac/addons.manifest.json')), /ENOENT/)
  await t.exception(readFile(path.join(projectRoot, 'qvac/sync-stack.validation.json')), /ENOENT/)
})

test('sync standalone writes contribution and addon manifest', async (t) => {
  const projectRoot = await createProject()
  await seedStockBareKit(projectRoot)
  await writePackage(projectRoot, '@qvac/sync-addon', '1.0.0')
  const build = await createBuild(projectRoot, ['@qvac/sync-addon'], {
    packages: [
      {
        name: '@qvac/sync-addon',
        version: '1.0.0',
        packagePath: 'node_modules/@qvac/sync-addon/package.json',
        singleton: true
      }
    ]
  })
  const plugin = createSyncExpoPlugin({ build: async () => build, packageVersion: '1.2.3' })

  await compile(plugin, projectRoot)

  const manifest = await readJson(path.join(projectRoot, 'qvac/addons.manifest.json'))
  t.alike(manifest.addons, ['@qvac/sync-addon'])
  t.ok(await exists(path.join(projectRoot, 'qvac/contributions/sync.json')))
  const validation = await readJson(path.join(projectRoot, 'qvac/sync-stack.validation.json'))
  t.is(validation.ok, true)
})

test('sync standalone installs manifest-aware BareKit linkers from stock shape', async (t) => {
  const projectRoot = await createProject()
  await seedStockBareKit(projectRoot)
  const build = await createBuild(projectRoot)
  const plugin = createSyncExpoPlugin({ build: async () => build, packageVersion: '1.2.3' })

  await compile(plugin, projectRoot)

  const android = await readFile(
    path.join(projectRoot, 'node_modules/react-native-bare-kit/android/link.mjs'),
    'utf8'
  )
  const ios = await readFile(
    path.join(projectRoot, 'node_modules/react-native-bare-kit/ios/link.mjs'),
    'utf8'
  )
  t.ok(android.includes(`const projectRoot = ${JSON.stringify(projectRoot)}`))
  t.ok(ios.includes(`const projectRoot = ${JSON.stringify(projectRoot)}`))
  t.ok(android.includes("path.join(projectRoot, 'qvac', 'addons.manifest.json')"))
  t.ok(ios.includes("path.join(projectRoot, 'qvac', 'addons.manifest.json')"))
  t.ok(android.includes('android-arm64'))
  t.ok(ios.includes('ios-arm64'))
  t.is(android.includes("path.join(__filename, '..', '..', '..', '..')"), false)
  t.is(ios.includes("path.join(__filename, '..', '..', '..', '..')"), false)
})

test('sync contributor leaves BareKit linkers unchanged', async (t) => {
  const projectRoot = await createProject()
  await seedStockBareKit(projectRoot)
  const androidPath = path.join(projectRoot, 'node_modules/react-native-bare-kit/android/link.mjs')
  const iosPath = path.join(projectRoot, 'node_modules/react-native-bare-kit/ios/link.mjs')
  const androidBefore = await readFile(androidPath, 'utf8')
  const iosBefore = await readFile(iosPath, 'utf8')
  const build = await createBuild(projectRoot)
  const plugin = createSyncExpoPlugin({
    mode: 'contributor',
    build: async () => build,
    packageVersion: '1.2.3'
  })

  await compile(plugin, projectRoot)

  t.is(await readFile(androidPath, 'utf8'), androidBefore)
  t.is(await readFile(iosPath, 'utf8'), iosBefore)
  await t.exception(readFile(path.join(projectRoot, 'qvac/addons.manifest.json')), /ENOENT/)
})

test('sync standalone fails closed when BareKit linker files are missing', async (t) => {
  const projectRoot = await createProject()
  const bareKitRoot = path.join(projectRoot, 'node_modules', 'react-native-bare-kit')
  await mkdir(path.join(bareKitRoot, 'android'), { recursive: true })
  await mkdir(path.join(bareKitRoot, 'ios'), { recursive: true })
  await writeFile(
    path.join(bareKitRoot, 'package.json'),
    `${JSON.stringify({ name: 'react-native-bare-kit', version: '0.14.0' })}\n`
  )
  const build = await createBuild(projectRoot)
  const plugin = createSyncExpoPlugin({ build: async () => build, packageVersion: '1.2.3' })

  await t.exception(compile(plugin, projectRoot), /Failed to read BareKit linker/i)
})

test('sync standalone fails closed when react-native-bare-kit is missing', async (t) => {
  const projectRoot = await createProject()
  const build = await createBuild(projectRoot)
  const plugin = createSyncExpoPlugin({ build: async () => build, packageVersion: '1.2.3' })

  await t.exception(
    compile(plugin, projectRoot),
    /requires react-native-bare-kit to prepare native linking/i
  )
})

test('sync expo plugin builds once across android and ios mods', async (t) => {
  const projectRoot = await createProject()
  const build = await createBuild(projectRoot)
  let calls = 0
  const plugin = createSyncExpoPlugin({
    mode: 'contributor',
    build: async () => {
      calls += 1
      return build
    }
  })

  await compile(plugin, projectRoot, ['android', 'ios'])

  t.is(calls, 1)
})

test('sync contribution fails closed for missing artifacts', async (t) => {
  const projectRoot = await createProject()
  const build = await createBuild(projectRoot)
  await unlink(build.bundlePath)

  await t.exception(composeSyncContribution(projectRoot, build), /missing sync artifact.*bundle/i)
})

test('sync contribution fails closed for wrong contract and missing hosts', async (t) => {
  const projectRoot = await createProject()
  const wrongContract = await createBuild(projectRoot, [], { contract: 'wrong.contract' })
  await t.exception(composeSyncContribution(projectRoot, wrongContract), /malformed sync metadata/i)

  const missingHosts = await createBuild(projectRoot, [], { hosts: ['android-arm64'] })
  await t.exception(composeSyncContribution(projectRoot, missingHosts), /malformed sync metadata/i)
})

test('sync contribution rejects conflicting addon versions', async (t) => {
  const projectRoot = await createProject()
  await writePackage(projectRoot, '@qvac/demo', '2.0.0')
  await writePackage(path.join(projectRoot, 'node_modules/@qvac/holder'), '@qvac/demo', '1.0.0')
  const build = await createBuild(projectRoot, [
    'linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0',
    'linked:qvac__demo.2.0.0.framework/qvac__demo.2.0.0'
  ])

  await t.exception(
    composeSyncContribution(projectRoot, build),
    /conflicting versions for native addon @qvac\/demo/i
  )
})

test('sync contribution rejects unresolved addon versions', async (t) => {
  const projectRoot = await createProject()
  const build = await createBuild(projectRoot, [
    'linked:qvac__missing.9.9.9.framework/qvac__missing.9.9.9'
  ])

  await t.exception(
    composeSyncContribution(projectRoot, build),
    /unable to resolve required package version for @qvac\/missing@9\.9\.9/i
  )
})

test('sync contribution normalizes native addon identities', async (t) => {
  const projectRoot = await createProject()
  await writePackage(projectRoot, '@qvac/demo', '1.0.0')
  const build = await createBuild(projectRoot, [
    'linked:qvac__demo.1.0.0.framework/qvac__demo.1.0.0'
  ], {
    packages: [
      {
        name: '@qvac/demo',
        version: '1.0.0',
        packagePath: 'node_modules/@qvac/demo/package.json',
        singleton: true
      }
    ]
  })

  const contribution = await composeSyncContribution(projectRoot, build)

  t.alike(contribution.nativeAddons, [{ name: '@qvac/demo', version: '1.0.0' }])
  t.alike(contribution.packages, [
    {
      name: '@qvac/demo',
      version: '1.0.0',
      packagePath: 'node_modules/@qvac/demo/package.json',
      singleton: true
    }
  ])
})

test('sync contribution prefers on-disk metadata over in-memory build result', async (t) => {
  const projectRoot = await createProject()
  const build = await createBuild(projectRoot)
  const poisoned = {
    ...build,
    metadata: {
      ...build.metadata,
      contract: 'wrong.contract'
    }
  }

  const contribution = await composeSyncContribution(projectRoot, poisoned)

  t.is(contribution.contract, 'qvac.sync')
  t.is(contribution.bundleId, 'sync-bundle')
})

test('sync standalone validation fails closed for package and host inconsistencies', async (t) => {
  const missingHost = validateStandaloneContribution({
    schemaVersion: 1,
    packageName: '@qvac/sync',
    packageVersion: '1.0.0',
    contract: 'qvac.sync',
    protocolVersion: 1,
    bundleId: 'sync-bundle',
    hosts: ['android-arm64'],
    nativeAddons: [],
    packages: [],
    harnessPath: '/tmp/sync.js',
    metadataPath: '/tmp/sync.metadata.json',
    bundlePath: '/tmp/sync.bundle.mjs'
  })
  t.is(missingHost.ok, false)
  t.ok(missingHost.errors.some((error) => /missing required host ios-arm64/i.test(error)))

  const missingPackage = validateStandaloneContribution({
    schemaVersion: 1,
    packageName: '@qvac/sync',
    packageVersion: '1.0.0',
    contract: 'qvac.sync',
    protocolVersion: 1,
    bundleId: 'sync-bundle',
    hosts: requiredHosts,
    nativeAddons: [{ name: '@qvac/demo', version: '1.0.0' }],
    packages: [],
    harnessPath: '/tmp/sync.js',
    metadataPath: '/tmp/sync.metadata.json',
    bundlePath: '/tmp/sync.bundle.mjs'
  })
  t.is(missingPackage.ok, false)
  t.ok(
    missingPackage.errors.some((error) =>
      /packages are required when native addons are declared/i.test(error)
    )
  )

  const singletonConflict = validateStandaloneContribution({
    schemaVersion: 1,
    packageName: '@qvac/sync',
    packageVersion: '1.0.0',
    contract: 'qvac.sync',
    protocolVersion: 1,
    bundleId: 'sync-bundle',
    hosts: requiredHosts,
    nativeAddons: [{ name: 'bare-fs', version: '4.7.4' }],
    packages: [
      {
        name: 'bare-fs',
        version: '4.7.4',
        packagePath: 'a/package.json',
        singleton: true
      },
      {
        name: 'bare-fs',
        version: '4.8.0',
        packagePath: 'b/package.json',
        singleton: true
      }
    ],
    harnessPath: '/tmp/sync.js',
    metadataPath: '/tmp/sync.metadata.json',
    bundlePath: '/tmp/sync.bundle.mjs'
  })
  t.is(singletonConflict.ok, false)
  t.ok(
    singletonConflict.errors.some((error) =>
      /conflicting singleton package versions for bare-fs/i.test(error)
    )
  )
})

const stockAndroidLinker = `import path from 'path'
import { fileURLToPath } from 'url'
import link from 'bare-link'

const __filename = fileURLToPath(import.meta.url)

for await (const resource of link(path.join(__filename, '..', '..', '..', '..'), {
  hosts: ['android-arm64', 'android-arm', 'android-ia32', 'android-x64'],
  out: path.join(__filename, '..', 'src', 'main', 'addons')
})) {
  console.log('Wrote', resource)
}
`

const stockIosLinker = `import path from 'path'
import { fileURLToPath } from 'url'
import link from 'bare-link'

const __filename = fileURLToPath(import.meta.url)

for await (const resource of link(path.join(__filename, '..', '..', '..', '..'), {
  hosts: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
  out: path.join(__filename, '..', 'addons')
})) {
  console.log('Wrote', resource)
}
`

async function createProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'sync-expo-plugin-'))
  temporaryPaths.push(projectRoot)
  await writeFile(path.join(projectRoot, 'package.json'), '{"name":"test-app"}\n')
  return projectRoot
}

async function seedStockBareKit(projectRoot: string) {
  const bareKitRoot = path.join(projectRoot, 'node_modules', 'react-native-bare-kit')
  await mkdir(path.join(bareKitRoot, 'android'), { recursive: true })
  await mkdir(path.join(bareKitRoot, 'ios'), { recursive: true })
  await writeFile(
    path.join(bareKitRoot, 'package.json'),
    `${JSON.stringify({ name: 'react-native-bare-kit', version: '0.14.0' })}\n`
  )
  await writeFile(path.join(bareKitRoot, 'android', 'link.mjs'), stockAndroidLinker)
  await writeFile(path.join(bareKitRoot, 'ios', 'link.mjs'), stockIosLinker)
}

async function createBuild(
  projectRoot: string,
  nativeAddons: readonly string[] = [],
  overrides: {
    readonly contract?: string
    readonly hosts?: readonly string[]
    readonly packages?: readonly {
      readonly name: string
      readonly version: string
      readonly packagePath: string
      readonly singleton: boolean
    }[]
  } = {}
) {
  const output = path.join(projectRoot, '.generated')
  const harnessPath = path.join(output, 'sync.js')
  const metadataPath = path.join(output, 'sync.metadata.json')
  const bundlePath = path.join(output, 'sync.bundle.mjs')
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(harnessPath, 'export default null\n'),
    writeFile(bundlePath, 'export default null\n')
  ])
  const metadata = {
    bundleId: 'sync-bundle',
    contract: overrides.contract ?? 'qvac.sync',
    protocolVersion: 1,
    hosts: overrides.hosts ?? requiredHosts,
    nativeAddons,
    packages: overrides.packages ?? []
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
  return {
    descriptor: {
      entryPath: path.join(output, 'entry.ts'),
      harnessPath,
      metadataPath,
      contract: 'qvac.sync' as const,
      protocolVersion: 1 as const,
      hosts: metadata.hosts
    },
    bundlePath,
    metadata
  }
}

async function compile(
  plugin: ReturnType<typeof createSyncExpoPlugin>,
  projectRoot: string,
  platforms: Array<'android' | 'ios'> = ['android']
) {
  const config = plugin({
    name: 'sync-test',
    slug: 'sync-test',
    _internal: { projectRoot }
  }, undefined)
  await compileModsAsync(config, {
    projectRoot,
    platforms,
    introspect: false,
    assertMissingModProviders: false,
    ignoreExistingNativeFiles: true
  })
}

async function writePackage(root: string, name: string, version: string) {
  const directory = path.join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ name, version })}\n`)
}

async function readJson(
  filePath: string
): Promise<{
  readonly packageVersion?: string
  readonly nativeAddons?: readonly { readonly name: string; readonly version: string }[]
  readonly addons?: readonly string[]
  readonly ok?: boolean
}> {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function exists(filePath: string) {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}
