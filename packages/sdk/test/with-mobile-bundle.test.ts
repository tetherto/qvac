import test from 'brittle'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAddonPlatformPackage,
  resolvePlatformPackageName
} from '@/expo/plugins/patches/qvac-platform-addons'
import {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  buildMobileBundle,
  mobileHostsForPlatform,
  patchBareKitLinkers,
  runIOSAddonLinker
} from '@/expo/plugins/withMobileBundle'
import { HostPrebuildsMissingError } from '@/utils/errors-client'
import { installFakePackageManager, withPath } from './fixtures/fake-package-manager'
import {
  RUNTIME_ADDON_ANDROID_PACKAGE,
  RUNTIME_ADDON_IOS_PACKAGE,
  RUNTIME_ADDON_VERSION,
  SPLIT_ADDON_ANDROID_PACKAGE,
  SPLIT_ADDON_IOS_PACKAGE,
  SPLIT_ADDON_VERSION,
  createSplitAddonProject
} from './fixtures/split-addon-project'

test('mobileHostsForPlatform: each build target bundles and verifies only its own hosts', (t) => {
  t.alike(mobileHostsForPlatform('android'), ['android-arm64'])
  t.alike(mobileHostsForPlatform('ios'), ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'])
  t.alike(Object.keys(MOBILE_HOSTS_BY_PLATFORM), ['android', 'ios'])
  t.exception(() => mobileHostsForPlatform('web'), /only supports android and ios/)
})

test('MOBILE_HOSTS: the shared bundle covers every mobile host', (t) => {
  t.alike(MOBILE_HOSTS, ['android-arm64', 'ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'])
  t.alike(
    MOBILE_HOSTS,
    [...MOBILE_HOSTS_BY_PLATFORM.android, ...MOBILE_HOSTS_BY_PLATFORM.ios],
    'a dual-platform prebuild writes one bundle, so it must cover both platforms'
  )
})

test('resolvePlatformPackageName: reads slice names from #host-addon for hosts and build targets', (t) => {
  const hostAddon = hostAddonMap('@qvac/tts-ggml')
  t.is(resolvePlatformPackageName(hostAddon, 'android'), '@qvac/tts-ggml-android-arm64')
  t.is(resolvePlatformPackageName(hostAddon, 'android-arm64'), '@qvac/tts-ggml-android-arm64')
  t.is(resolvePlatformPackageName(hostAddon, 'ios'), '@qvac/tts-ggml-ios')
  t.is(resolvePlatformPackageName(hostAddon, 'ios-arm64'), '@qvac/tts-ggml-ios')
  t.is(resolvePlatformPackageName(hostAddon, 'ios-arm64-simulator'), '@qvac/tts-ggml-ios')
  t.is(resolvePlatformPackageName(hostAddon, 'darwin-arm64'), '@qvac/tts-ggml-darwin-arm64')
  t.is(resolvePlatformPackageName(hostAddon, 'linux-x64'), '@qvac/tts-ggml-linux-x64')
  t.is(
    resolvePlatformPackageName(hostAddonMap('@qvac/asr-ggml'), 'android-arm64'),
    '@qvac/asr-ggml-android-arm64'
  )
  t.is(
    resolvePlatformPackageName(hostAddonMap('@qvac/audiogen-ggml'), 'ios'),
    '@qvac/audiogen-ggml-ios'
  )
  t.is(
    resolveAddonPlatformPackage('@qvac/tts-ggml', hostAddon, 'android-arm64'),
    '@qvac/tts-ggml-android-arm64'
  )
  t.is(resolveAddonPlatformPackage('@qvac/other', hostAddon, 'android-arm64'), null)
  t.is(resolvePlatformPackageName(undefined, 'android-arm64'), null)
})

test('MOBILE_UNSUPPORTED_MODULES: the desktop-only spawn path stays out of mobile bundles', (t) => {
  t.alike(MOBILE_UNSUPPORTED_MODULES, ['bare-runtime/spawn'])
})

test('patchBareKitLinkers: returns paths for patched platforms', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-linker-patch-'))
  const projectRoot = join(fixtureDir, 'project')
  const bareKitPath = join(projectRoot, 'node_modules', 'react-native-bare-kit')
  const sdkPath = join(fixtureDir, 'sdk')
  const patchesDir = join(sdkPath, 'src', 'expo', 'plugins', 'patches')
  const androidTarget = join(bareKitPath, 'android', 'link.mjs')
  const iosTarget = join(bareKitPath, 'ios', 'link.mjs')
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))

  mkdirSync(join(bareKitPath, 'android'), { recursive: true })
  mkdirSync(join(bareKitPath, 'ios'), { recursive: true })
  mkdirSync(patchesDir, { recursive: true })
  writeFileSync(join(patchesDir, 'android-link.mjs'), 'android patch')
  writeFileSync(join(patchesDir, 'ios-link.mjs'), 'ios patch')

  const linkerPaths = patchBareKitLinkers(projectRoot, sdkPath)

  t.alike(linkerPaths, { android: androidTarget, ios: iosTarget })
  t.ok(existsSync(androidTarget), 'copies the Android linker patch')
  t.ok(existsSync(iosTarget), 'copies the iOS linker patch')
})

test('patchBareKitLinkers: leaves the stock linker when its patch is missing', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-linker-patch-'))
  const projectRoot = join(fixtureDir, 'project')
  const bareKitPath = join(projectRoot, 'node_modules', 'react-native-bare-kit')
  const sdkPath = join(fixtureDir, 'sdk')
  const patchesDir = join(sdkPath, 'src', 'expo', 'plugins', 'patches')
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))

  mkdirSync(join(bareKitPath, 'android'), { recursive: true })
  mkdirSync(join(bareKitPath, 'ios'), { recursive: true })
  mkdirSync(patchesDir, { recursive: true })
  writeFileSync(join(patchesDir, 'android-link.mjs'), 'android patch')

  t.alike(patchBareKitLinkers(projectRoot, sdkPath), {
    android: join(bareKitPath, 'android', 'link.mjs'),
    ios: null
  })
  t.absent(existsSync(join(bareKitPath, 'ios', 'link.mjs')), 'the stock iOS linker stays')
})

test('runIOSAddonLinker: waits for the linker to finish', async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-ios-linker-'))
  const linkerPath = join(fixtureDir, 'link.mjs')
  const markerPath = join(fixtureDir, 'linked')
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))

  writeFileSync(
    linkerPath,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, '')\n`
  )

  await runIOSAddonLinker(linkerPath)

  t.ok(existsSync(markerPath), 'linker completed before the helper resolved')
})

test('runIOSAddonLinker: rejects when the linker fails', async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-ios-linker-'))
  const linkerPath = join(fixtureDir, 'link.mjs')
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))

  writeFileSync(linkerPath, `console.error('fixture failure')\nprocess.exit(7)\n`)

  let error: Error | undefined
  try {
    await runIOSAddonLinker(linkerPath)
  } catch (cause) {
    error = cause as Error
  }

  t.ok(error, 'expected the helper to reject')
  t.ok(error?.message.includes('code 7'), 'reports the child exit code')
  t.ok(error?.message.includes('fixture failure'), 'reports linker diagnostics')
})

function androidPrebuildMod(projectRoot: string) {
  return {
    modRequest: { projectRoot, platform: 'android' }
  } as unknown as Parameters<typeof buildMobileBundle>[0]
}

const posixOnly = { skip: process.platform === 'win32' }

test(
  'buildMobileBundle: fails prebuild and names the missing platform package by default',
  posixOnly,
  async (t) => {
    const project = createSplitAddonProject(join('node_modules', '@qvac', 'sdk'))
    t.teardown(project.cleanup)
    const pm = installFakePackageManager(project.projectRoot, 'pnpm')

    let error: unknown
    try {
      await withPath(pm.binDir, () =>
        buildMobileBundle(androidPrebuildMod(project.projectRoot), {})
      )
    } catch (cause) {
      error = cause
    }

    t.ok(error instanceof HostPrebuildsMissingError, 'bundling fails')
    t.alike(
      (error as HostPrebuildsMissingError).dependencies,
      {
        [SPLIT_ADDON_ANDROID_PACKAGE]: SPLIT_ADDON_VERSION,
        [SPLIT_ADDON_IOS_PACKAGE]: SPLIT_ADDON_VERSION
      },
      'the failure names the exact pins to add for every host the shared bundle covers'
    )
    t.alike(pm.calls(), [], 'nothing is installed without the option')
  }
)

test(
  'buildMobileBundle: installMissingPrebuilds installs the packages of every mobile host',
  posixOnly,
  async (t) => {
    const project = createSplitAddonProject(join('node_modules', '@qvac', 'sdk'))
    t.teardown(project.cleanup)
    const pm = installFakePackageManager(project.projectRoot, 'pnpm')

    await withPath(pm.binDir, () =>
      buildMobileBundle(androidPrebuildMod(project.projectRoot), { installMissingPrebuilds: true })
    )

    t.alike(
      pm.calls(),
      [
        {
          cwd: project.projectRoot,
          args: [
            'add',
            '--save-exact',
            `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`,
            `${SPLIT_ADDON_IOS_PACKAGE}@${SPLIT_ADDON_VERSION}`
          ]
        }
      ],
      'the bundle is shared by both platforms, so an Android prebuild installs both'
    )
    t.ok(
      existsSync(join(project.sdkPath, 'dist', 'worker.mobile.bundle.js')),
      'the verified bundle is copied into the SDK'
    )
  }
)

test(
  'buildMobileBundle: installMissingPrebuilds finds the SDK addon in a pnpm store',
  posixOnly,
  async (t) => {
    const project = createSplitAddonProject(join('node_modules', '@qvac', 'sdk'), {
      layout: 'pnpm'
    })
    t.teardown(project.cleanup)
    t.absent(
      existsSync(join(project.projectRoot, 'node_modules', '@qvac', 'fake-ggml')),
      'the addon is not in the top-level node_modules'
    )
    const pm = installFakePackageManager(project.projectRoot, 'pnpm')

    await withPath(pm.binDir, () =>
      buildMobileBundle(androidPrebuildMod(project.projectRoot), { installMissingPrebuilds: true })
    )

    t.alike(pm.calls(), [
      {
        cwd: project.projectRoot,
        args: [
          'add',
          '--save-exact',
          `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`,
          `${SPLIT_ADDON_IOS_PACKAGE}@${SPLIT_ADDON_VERSION}`
        ]
      }
    ])
  }
)

for (const layout of ['pnpm', 'hoisted'] as const) {
  test(
    `buildMobileBundle: installMissingPrebuilds covers an addon's split-addon dependency (${layout})`,
    posixOnly,
    async (t) => {
      const project = createSplitAddonProject(join('node_modules', '@qvac', 'sdk'), {
        layout,
        withRuntime: true
      })
      t.teardown(project.cleanup)
      t.absent(
        existsSync(join(project.projectRoot, 'node_modules', '@qvac', 'fake-runtime')),
        'the dependency is not in the top-level node_modules'
      )
      const pm = installFakePackageManager(project.projectRoot, 'pnpm')

      await withPath(pm.binDir, () =>
        buildMobileBundle(androidPrebuildMod(project.projectRoot), {
          installMissingPrebuilds: true
        })
      )

      t.alike(pm.calls(), [
        {
          cwd: project.projectRoot,
          args: [
            'add',
            '--save-exact',
            `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`,
            `${SPLIT_ADDON_IOS_PACKAGE}@${SPLIT_ADDON_VERSION}`,
            `${RUNTIME_ADDON_ANDROID_PACKAGE}@${RUNTIME_ADDON_VERSION}`,
            `${RUNTIME_ADDON_IOS_PACKAGE}@${RUNTIME_ADDON_VERSION}`
          ]
        }
      ])
    }
  )
}

function hostAddonMap(metaName: string) {
  return {
    linux: { x64: `${metaName}-linux-x64`, arm64: `${metaName}-linux-arm64` },
    darwin: { arm64: `${metaName}-darwin-arm64`, x64: `${metaName}-darwin-x64` },
    android: { arm64: `${metaName}-android-arm64` },
    ios: `${metaName}-ios`,
    default: './addon-unavailable.js'
  }
}
