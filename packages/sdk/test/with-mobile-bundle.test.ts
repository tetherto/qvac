import test from 'brittle'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveAddonPlatformPackage,
  resolvePlatformPackageName
} from '@/commands/verify/platform-addons'
import {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  buildMobileBundle,
  mobileHostsForPlatform
} from '@/expo/plugins/withMobileBundle'
import { BundleVerificationFailedError } from '@/utils/errors-client'
import { installFakePackageManager, withPath } from './fixtures/fake-package-manager'
import {
  RUNTIME_ADDON_ANDROID_PACKAGE,
  RUNTIME_ADDON_VERSION,
  SPLIT_ADDON_ANDROID_PACKAGE,
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

    t.ok(error instanceof BundleVerificationFailedError, 'verification fails')
    const details = String((error as Error | undefined)?.cause)
    t.ok(
      details.includes(`"${SPLIT_ADDON_ANDROID_PACKAGE}": "${SPLIT_ADDON_VERSION}"`),
      'the failure names the exact pin to add'
    )
    t.alike(pm.calls(), [], 'nothing is installed without the option')
  }
)

test(
  'buildMobileBundle: installMissingPrebuilds installs the current target package',
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
          args: ['add', '--save-exact', `${SPLIT_ADDON_ANDROID_PACKAGE}@${SPLIT_ADDON_VERSION}`]
        }
      ],
      'installs only the Android package for an Android prebuild, with the app package manager'
    )
    t.ok(
      existsSync(join(project.sdkPath, 'dist', 'worker-mobile', 'index.bundle.mjs')),
      'the verified bundle is copied into the SDK'
    )
    t.ok(
      existsSync(join(project.sdkPath, 'dist', 'worker-mobile', 'index.mjs')),
      'the harness is copied beside it'
    )
  }
)

test(
  "buildMobileBundle: installMissingPrebuilds covers an addon's split-addon dependency",
  posixOnly,
  async (t) => {
    const project = createSplitAddonProject(join('node_modules', '@qvac', 'sdk'), {
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
          `${RUNTIME_ADDON_ANDROID_PACKAGE}@${RUNTIME_ADDON_VERSION}`
        ]
      }
    ])
  }
)

function hostAddonMap(metaName: string) {
  return {
    linux: {
      x64: [`${metaName}-linux-x64`, './addon-unavailable.js'],
      arm64: [`${metaName}-linux-arm64`, './addon-unavailable.js']
    },
    darwin: {
      arm64: [`${metaName}-darwin-arm64`, './addon-unavailable.js'],
      x64: [`${metaName}-darwin-x64`, './addon-unavailable.js']
    },
    android: { arm64: [`${metaName}-android-arm64`, './addon-unavailable.js'] },
    ios: [`${metaName}-ios`, './addon-unavailable.js'],
    default: './addon-unavailable.js'
  }
}
