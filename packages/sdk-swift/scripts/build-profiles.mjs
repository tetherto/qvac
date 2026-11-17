#!/usr/bin/env node
// Builds the published worker profiles into build/profiles: one
// QvacWorker<Profile>.xcframework.zip per profile, one zip per native addon, and
// manifest.json with each zip's Swift Package Manager checksum. Each iOS
// framework carries Apple's privacy manifest.
//
//   node scripts/build-profiles.mjs [--profile <name>]... [--host <host>]...
//     [--install-missing-prebuilds]
//
// The profiles are the Kotlin SDK's published ones (packages/sdk-kotlin
// qvac.config*.json). Hosts default to iOS and Apple silicon macOS. Needs macOS
// with Xcode, packages/sdk built and installed, and the platform packages of
// each host; --install-missing-prebuilds adds the missing iOS ones to
// packages/sdk.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { bareKitPin, readManifest } from './manifest.mjs'

const PROFILES = {
  aio: { framework: 'QvacWorkerAll', config: 'qvac.config.json' },
  assistant: { framework: 'QvacWorkerAssistant', config: 'qvac.config.assistant.json' },
  llm: { framework: 'QvacWorkerLLM', config: 'qvac.config.llm.json' },
  speech: { framework: 'QvacWorkerSpeech', config: 'qvac.config.speech.json' },
  vision: { framework: 'QvacWorkerVision', config: 'qvac.config.vision.json' },
  media: { framework: 'QvacWorkerMedia', config: 'qvac.config.media.json' },
  robotics: { framework: 'QvacWorkerRobotics', config: 'qvac.config.robotics.json' }
}

const packageManifest = await readManifest()

// The bundler resolves split addons per host only within one family, so iOS
// and macOS each get their own bundle.
const HOSTS = {
  'ios-arm64': { family: 'ios', sdk: 'iphoneos', target: `arm64-apple-ios${packageManifest.ios}` },
  'ios-arm64-simulator': {
    family: 'ios',
    sdk: 'iphonesimulator',
    target: `arm64-apple-ios${packageManifest.ios}-simulator`
  },
  'ios-x64-simulator': {
    family: 'ios',
    sdk: 'iphonesimulator',
    target: `x86_64-apple-ios${packageManifest.ios}-simulator`
  },
  'darwin-arm64': { family: 'macos', sdk: 'macosx', target: `arm64-apple-macos${packageManifest.macos}` },
  'darwin-x64': { family: 'macos', sdk: 'macosx', target: `x86_64-apple-macos${packageManifest.macos}` }
}

const { values: options } = parseArgs({
  options: {
    profile: { type: 'string', multiple: true, default: Object.keys(PROFILES) },
    host: {
      type: 'string',
      multiple: true,
      default: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator', 'darwin-arm64']
    },
    'install-missing-prebuilds': { type: 'boolean', default: false }
  }
})

for (const name of options.profile) {
  if (!(name in PROFILES)) throw new Error(`Unknown profile ${name}; known: ${Object.keys(PROFILES).join(', ')}`)
}
for (const host of options.host) {
  if (!(host in HOSTS)) throw new Error(`Unknown host ${host}; known: ${Object.keys(HOSTS).join(', ')}`)
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const sdkRoot = path.join(repoRoot, 'packages', 'sdk')
const kotlinRoot = path.join(repoRoot, 'packages', 'sdk-kotlin')
const outputRoot = path.join(packageRoot, 'build', 'profiles')
const scratchRoot = path.join(packageRoot, 'build', 'profiles-work')

// CFBundleVersion takes digits and dots only, so a prerelease suffix is dropped.
const { version: sdkVersion } = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'))
const bundleVersion = sdkVersion.replace(/[-+].*$/, '')

const { bundleSdk } = await import(
  pathToFileURL(path.join(sdkRoot, 'dist', 'src', 'commands', 'index.js')).href
)

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** The .framework of each platform slice inside an .xcframework. */
async function slicesOf(xcframework) {
  const slices = []
  for (const entry of await readdir(xcframework, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    for (const inner of await readdir(path.join(xcframework, entry.name))) {
      if (inner.endsWith('.framework')) slices.push(path.join(xcframework, entry.name, inner))
    }
  }
  return slices
}

// Apple's required-reason API categories, the symbols that fall under each,
// and the reason the worker uses them for.
const REQUIRED_REASONS = [
  {
    category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    symbols: ['stat', 'fstat', 'fstatat', 'lstat', 'getattrlist', 'getattrlistbulk', 'fgetattrlist', 'getattrlistat'],
    reason: 'C617.1'
  },
  {
    category: 'NSPrivacyAccessedAPICategoryDiskSpace',
    symbols: ['statfs', 'statvfs', 'fstatfs', 'fstatvfs', 'getattrlist', 'fgetattrlist', 'getattrlistat'],
    reason: 'E174.1'
  },
  {
    category: 'NSPrivacyAccessedAPICategorySystemBootTime',
    symbols: ['mach_absolute_time'],
    reason: '35F9.1'
  }
]

/** The privacy manifest of an iOS framework, from the symbols its binary imports. */
function privacyManifest(framework) {
  const binary = path.join(framework, path.basename(framework, '.framework'))
  const imported = new Set(
    run('nm', ['-u', binary])
      .split('\n')
      .map((symbol) => symbol.replace(/^_/, '').replace(/\$.*$/, ''))
  )
  const types = REQUIRED_REASONS.filter(({ symbols }) => symbols.some((symbol) => imported.has(symbol))).map(
    ({ category, reason }) =>
      `\t\t<dict>\n\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>${category}</string>\n` +
      `\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>\n\t\t\t<array>\n\t\t\t\t<string>${reason}</string>\n\t\t\t</array>\n\t\t</dict>\n`
  )
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    '\t<key>NSPrivacyTracking</key>\n\t<false/>\n' +
    '\t<key>NSPrivacyTrackingDomains</key>\n\t<array/>\n' +
    '\t<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>\n' +
    `\t<key>NSPrivacyAccessedAPITypes</key>\n\t<array>\n${types.join('')}\t</array>\n` +
    '</dict>\n</plist>\n'
  )
}

/**
 * One .xcframework from the slices of the same addon bundled per family, with
 * a privacy manifest in each iOS framework, signed ad hoc as bare-link signs
 * each family's own.
 */
async function joinXcframeworks(name, sources, work) {
  const joined = path.join(work, 'joined', `${name}.xcframework`)
  await mkdir(path.dirname(joined), { recursive: true })
  if (sources.length === 1) {
    await cp(sources[0], joined, { recursive: true, verbatimSymlinks: true })
  } else {
    const frameworks = (await Promise.all(sources.map(slicesOf))).flat()
    run('xcodebuild', ['-create-xcframework', ...frameworks.flatMap((item) => ['-framework', item]), '-output', joined])
  }
  for (const framework of await slicesOf(joined)) {
    if (!path.basename(path.dirname(framework)).startsWith('ios-')) continue
    await writeFile(path.join(framework, 'PrivacyInfo.xcprivacy'), privacyManifest(framework))
    run('plutil', ['-lint', '-s', path.join(framework, 'PrivacyInfo.xcprivacy')])
    run('codesign', ['--force', '--sign', '-', framework])
  }
  run('codesign', ['--force', '--sign', '-', joined])
  return joined
}

/** Zips an .xcframework the way Swift Package Manager expects: the framework at the archive's root. */
async function zipXcframework(xcframework, zip) {
  await rm(zip, { force: true })
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', xcframework, zip])
  return sha256(zip)
}

/** Binary targets a generated harness manifest lists: name and relative path. */
function binaryTargets(manifest) {
  return [...manifest.matchAll(/\.binaryTarget\(name: "([^"]+)", path: "([^"]+)"\)/g)].map((match) => ({
    name: match[1],
    path: match[2]
  }))
}

function resourcesOf(manifest) {
  return [...manifest.matchAll(/\.copy\("([^"]+)"\)/g)].map((match) => match[1])
}

/**
 * A resource-only framework that holds the worker bundle, for one SDK: a
 * dynamic library with no code, in the layout the SDK uses (versioned on macOS).
 */
async function workerFramework(framework, bundle, sdk, targets, work) {
  const root = path.join(work, sdk, `${framework}.framework`)
  const macos = sdk === 'macosx'
  const contents = macos ? path.join(root, 'Versions', 'A') : root
  const resources = macos ? path.join(contents, 'Resources') : contents
  await mkdir(resources, { recursive: true })

  const source = path.join(work, sdk, 'empty.c')
  await writeFile(source, '')
  const slices = []
  for (const target of targets) {
    const slice = path.join(work, sdk, `${framework}-${target}`)
    run('xcrun', [
      '--sdk', sdk, 'clang', '-dynamiclib', '-target', target, source, '-o', slice,
      '-install_name', `@rpath/${framework}.framework/${macos ? 'Versions/A/' : ''}${framework}`
    ])
    slices.push(slice)
  }
  run('xcrun', ['lipo', '-create', ...slices, '-output', path.join(contents, framework)])

  await cp(bundle, path.join(resources, 'index.bundle'))
  const identifier = `io.tether.qvac.worker.${framework.replace(/^QvacWorker/, '').toLowerCase()}`
  await writeFile(
    path.join(resources, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${framework}</string>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>${framework}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
  <key>CFBundleVersion</key><string>${bundleVersion}</string>
  ${macos ? '' : `<key>MinimumOSVersion</key><string>${packageManifest.ios}</string>`}
</dict>
</plist>
`
  )
  if (macos) {
    run('ln', ['-s', 'A', path.join(root, 'Versions', 'Current')])
    run('ln', ['-s', `Versions/Current/${framework}`, path.join(root, framework)])
    run('ln', ['-s', 'Versions/Current/Resources', path.join(root, 'Resources')])
  }
  run('codesign', ['--force', '--sign', '-', root])
  return root
}

const expectedBareKit = bareKitPin(packageManifest.text)
if (expectedBareKit === null) throw new Error('Package.swift pins no exact bare-kit-swift version')

await rm(outputRoot, { recursive: true, force: true })
await rm(scratchRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

const families = {}
for (const host of options.host) {
  const { family, sdk, target } = HOSTS[host]
  families[family] ??= { hosts: [], sdks: {} }
  families[family].hosts.push(host)
  ;(families[family].sdks[sdk] ??= []).push(target)
}

/** Bundles the profile for one family and returns its worker bundle and native addons. */
async function bundleFamily(framework, config, family, hosts, work) {
  const harness = path.join(work, `harness-${family}`)
  await bundleSdk({
    projectRoot: sdkRoot,
    sdkPath: sdkRoot,
    configPath: path.join(kotlinRoot, config),
    target: 'bare-kit',
    language: 'swift',
    outputDir: harness,
    hosts,
    installMissingPrebuilds: options['install-missing-prebuilds'],
    quiet: true
  })
  const manifest = await readFile(path.join(harness, 'Package.swift'), 'utf8')
  const pinned = bareKitPin(manifest)
  if (pinned !== expectedBareKit) {
    throw new Error(`bare-stow pins bare-kit-swift ${pinned}, but Package.swift pins ${expectedBareKit}`)
  }
  const resources = resourcesOf(manifest)
  if (resources.length !== 1 || path.basename(resources[0]) !== 'index.bundle') {
    throw new Error(`${framework} carries resources besides the worker bundle: ${resources.join(', ')}`)
  }
  const sources = (await readdir(path.join(harness, 'Sources'), { withFileTypes: true })).filter((entry) => entry.isDirectory())
  const addons = binaryTargets(manifest).map((target) => ({ name: target.name, xcframework: path.join(harness, target.path) }))
  for (const addon of addons) run('codesign', ['--verify', '--deep', '--strict', addon.xcframework])
  return { bundle: path.join(harness, 'Sources', sources[0].name, 'index.bundle'), addons }
}

const artifacts = {}
const profiles = {}
for (const name of options.profile) {
  const { framework, config } = PROFILES[name]
  const work = path.join(scratchRoot, name)
  const addonSources = new Map()
  const addonFamilies = new Map()
  const frameworks = []
  for (const [family, { hosts, sdks }] of Object.entries(families)) {
    console.log(`\n${framework}: bundling ${config} for ${hosts.join(', ')}`)
    const { bundle, addons } = await bundleFamily(framework, config, family, hosts, work)
    for (const addon of addons) {
      addonSources.set(addon.name, [...(addonSources.get(addon.name) ?? []), addon.xcframework])
      addonFamilies.set(addon.name, [...(addonFamilies.get(addon.name) ?? []), family])
    }
    for (const [sdk, targets] of Object.entries(sdks)) {
      frameworks.push(await workerFramework(framework, bundle, sdk, targets, work))
    }
  }

  for (const [addon, sources] of addonSources) {
    if (addon in artifacts) continue
    const xcframework = await joinXcframeworks(addon, sources, work)
    const zip = path.join(outputRoot, `${addon}.xcframework.zip`)
    artifacts[addon] = {
      file: path.basename(zip),
      checksum: await zipXcframework(xcframework, zip),
      platforms: addonFamilies.get(addon)
    }
  }
  const addons = [...addonSources.keys()]
  const xcframework = path.join(work, `${framework}.xcframework`)
  run('xcodebuild', ['-create-xcframework', ...frameworks.flatMap((item) => ['-framework', item]), '-output', xcframework])
  const zip = path.join(outputRoot, `${framework}.xcframework.zip`)
  artifacts[framework] = {
    file: path.basename(zip),
    checksum: await zipXcframework(xcframework, zip),
    platforms: Object.keys(families)
  }

  profiles[name] = { framework, addons }
  console.log(`${framework}: ${addons.length} native addons`)
}

await writeFile(
  path.join(outputRoot, 'manifest.json'),
  `${JSON.stringify({ bareKitSwift: expectedBareKit, hosts: options.host, profiles, artifacts }, null, 2)}\n`
)
await rm(scratchRoot, { recursive: true, force: true })
console.log(`\nWrote ${Object.keys(artifacts).length} archives and manifest.json to ${outputRoot}`)
