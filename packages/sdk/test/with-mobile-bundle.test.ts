import test from 'brittle'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAddonPlatformPackage,
  resolvePlatformAddonRoots,
  resolvePlatformPackageName
} from '@/expo/plugins/patches/qvac-platform-addons'
import {
  MOBILE_HOSTS,
  MOBILE_HOSTS_BY_PLATFORM,
  MOBILE_UNSUPPORTED_MODULES,
  mobileHostsForPlatform,
  patchBareKitLinkers,
  runIOSAddonLinker
} from '@/expo/plugins/withMobileBundle'

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

test('resolvePlatformAddonRoots: finds the inner addon of the installed platform package', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-platform-addon-'))
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))
  writeSplitAddon(fixtureDir, '@qvac/tts-ggml', '0.9.2')
  writeSplitAddon(fixtureDir, '@qvac/asr-ggml', '0.5.2')
  writeFatAddon(fixtureDir, '@qvac/llm-llamacpp', '0.53.0')

  const android = resolvePlatformAddonRoots(
    fixtureDir,
    ['@qvac/tts-ggml', '@qvac/asr-ggml', '@qvac/llm-llamacpp'],
    'android'
  )

  t.is(android.length, 2, 'only split addons need linking from their platform packages')
  t.is(android[0].pkg.name, '@qvac/tts-ggml', 'the inner addon carries the meta package name')
  t.is(android[0].pkg.version, '0.9.2')
  t.ok(
    android[0].dir.endsWith(join('@qvac', 'tts-ggml-android-arm64', 'addon')),
    'resolves the tts android slice'
  )
  t.is(android[1].pkg.name, '@qvac/asr-ggml')
  t.ok(
    android[1].dir.endsWith(join('@qvac', 'asr-ggml-android-arm64', 'addon')),
    'resolves the asr android slice'
  )

  const ios = resolvePlatformAddonRoots(fixtureDir, ['@qvac/tts-ggml', '@qvac/asr-ggml'], 'ios')
  t.ok(ios[0].dir.endsWith(join('@qvac', 'tts-ggml-ios', 'addon')), 'resolves the tts ios slice')
  t.ok(ios[1].dir.endsWith(join('@qvac', 'asr-ggml-ios', 'addon')), 'resolves the asr ios slice')
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

test('resolvePlatformAddonRoots: skips an addon whose platform package is absent', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'qvac-platform-addon-'))
  t.teardown(() => rmSync(fixtureDir, { recursive: true, force: true }))
  writeManifest(join(fixtureDir, 'node_modules', '@qvac', 'audiogen-ggml'), {
    name: '@qvac/audiogen-ggml',
    version: '0.4.1',
    addon: true,
    imports: { '#host-addon': hostAddonMap('@qvac/audiogen-ggml') }
  })

  t.alike(resolvePlatformAddonRoots(fixtureDir, ['@qvac/audiogen-ggml'], 'android'), [])
})

test('MOBILE_UNSUPPORTED_MODULES: desktop-only fit subprocess stays out of mobile bundles', (t) => {
  t.alike(MOBILE_UNSUPPORTED_MODULES, ['bare-runtime/spawn', '@qvac/model-fit/process'])
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
  mkdirSync(join(sdkPath, 'dist', 'src', 'expo', 'plugins', 'patches'), { recursive: true })
  writeFileSync(join(patchesDir, 'android-link.mjs'), 'android patch')
  writeFileSync(join(patchesDir, 'ios-link.mjs'), 'ios patch')
  writeFileSync(
    join(sdkPath, 'dist', 'src', 'expo', 'plugins', 'patches', 'qvac-platform-addons.js'),
    'resolver'
  )

  const linkerPaths = patchBareKitLinkers(projectRoot, sdkPath)

  t.alike(linkerPaths, { android: androidTarget, ios: iosTarget })
  t.ok(existsSync(androidTarget), 'copies the Android linker patch')
  t.ok(existsSync(iosTarget), 'copies the iOS linker patch')
  t.ok(
    existsSync(join(bareKitPath, 'android', 'qvac-platform-addons.mjs')),
    'copies the compiled resolver the Android patch imports'
  )
  t.ok(
    existsSync(join(bareKitPath, 'ios', 'qvac-platform-addons.mjs')),
    'copies the compiled resolver the iOS patch imports'
  )
})

test('patchBareKitLinkers: leaves the stock linker when the resolver is missing', (t) => {
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
  writeFileSync(join(patchesDir, 'ios-link.mjs'), 'ios patch')

  t.alike(patchBareKitLinkers(projectRoot, sdkPath), { android: null, ios: null })
  t.absent(
    existsSync(join(bareKitPath, 'android', 'link.mjs')),
    'a patch without its resolver must not be installed'
  )
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

function writeManifest(dir: string, manifest: unknown) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

function writeSplitAddon(fixtureDir: string, metaName: string, version: string) {
  const modules = join(fixtureDir, 'node_modules')
  writeManifest(join(modules, ...metaName.split('/')), {
    name: metaName,
    version,
    addon: true,
    imports: { '#host-addon': hostAddonMap(metaName) }
  })
  for (const [slice, host] of [
    [`${metaName}-android-arm64`, 'android-arm64'],
    [`${metaName}-ios`, 'ios-arm64']
  ]) {
    const addonDir = join(modules, ...slice.split('/'), 'addon')
    writeManifest(addonDir, { name: metaName, version, addon: true })
    mkdirSync(join(addonDir, 'prebuilds', host), { recursive: true })
  }
}

function writeFatAddon(fixtureDir: string, name: string, version: string) {
  const dir = join(fixtureDir, 'node_modules', ...name.split('/'))
  writeManifest(dir, { name, version, addon: true })
  mkdirSync(join(dir, 'prebuilds', 'android-arm64'), { recursive: true })
}
