import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundleSdk, formatVerifyBundleResult, hasErrors, verifyBundle } from '@qvac/sdk/commands'
import link from 'bare-link'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sdkRoot = path.join(projectRoot, '..', 'sdk')
const configPath = process.env.QVAC_KOTLIN_CONFIG
  ? path.resolve(process.env.QVAC_KOTLIN_CONFIG)
  : path.join(projectRoot, 'qvac.config.json')
const generatedRoot = process.env.QVAC_KOTLIN_GENERATED_ROOT
  ? path.resolve(process.env.QVAC_KOTLIN_GENERATED_ROOT)
  : path.join(projectRoot, 'android-barekit', 'build', 'generated', 'qvac', 'aio')
const assetsDirectory = path.join(generatedRoot, 'assets', 'qvac')
const addonsDirectory = path.join(generatedRoot, 'addons')
const classificationAssetsDirectory = path.join(assetsDirectory, 'classification')
const qvacConfig = JSON.parse(await fs.readFile(configPath, 'utf8'))
const profileName = process.env.QVAC_KOTLIN_PROFILE ?? path.basename(configPath, '.json')
const includesClassification = (qvacConfig.plugins ?? []).includes(
  '@qvac/sdk/ggml-classification/plugin'
)

const pluginCapabilities = new Map([
  ['@qvac/sdk/llamacpp-completion/plugin', ['LLM']],
  ['@qvac/sdk/llamacpp-embedding/plugin', ['EMBEDDINGS']],
  ['@qvac/sdk/whispercpp-transcription/plugin', ['TRANSCRIPTION']],
  ['@qvac/sdk/parakeet-transcription/plugin', ['TRANSCRIPTION']],
  ['@qvac/sdk/bci-whispercpp-transcription/plugin', ['TRANSCRIPTION']],
  ['@qvac/sdk/nmtcpp-translation/plugin', ['TRANSLATION']],
  ['@qvac/sdk/tts-ggml/plugin', ['TTS']],
  ['@qvac/sdk/ggml-ocr/plugin', ['OCR']],
  ['@qvac/sdk/ggml-classification/plugin', ['CLASSIFICATION']],
  ['@qvac/sdk/audiogen-ggml/plugin', ['AUDIO_GENERATION']],
  ['@qvac/sdk/sdcpp-generation/plugin', ['IMAGE_GENERATION', 'VIDEO_GENERATION', 'UPSCALING', 'WORLD']],
  ['@qvac/sdk/ggml-vla/plugin', ['VLA']],
])
const capabilities = [
  ...new Set((qvacConfig.plugins ?? []).flatMap((plugin) => pluginCapabilities.get(plugin) ?? []))
].sort()

await fs.rm(generatedRoot, { recursive: true, force: true })
await fs.mkdir(assetsDirectory, { recursive: true })
await fs.mkdir(addonsDirectory, { recursive: true })
if (includesClassification) await fs.mkdir(classificationAssetsDirectory, { recursive: true })

// Bundle the checkout's packages/sdk. The worker build owns compiling it.
const bundleSdkPath = ensureWorkspaceSdk(sdkRoot)
const modulesRoot = bundleSdkPath ?? projectRoot
const classificationWeightsSource = classificationWeightsPath(modulesRoot)

const bundle = await bundleSdk({
  projectRoot,
  configPath,
  ...(bundleSdkPath !== undefined && { sdkPath: bundleSdkPath }),
  hosts: ['android-arm64'],
  defer: ['react-native-bare-kit', '@qvac/sdk/worker.mobile.bundle'],
  quiet: true
})

// Addon native prebuilds ship in per-platform packages that are not
// dependencies of the meta, so install the ones this bundle's addons name for
// android-arm64, at each meta's installed version.
await ensureHostPrebuilds(bundle.manifestPath, 'android-arm64', modulesRoot)

const verification = await verifyBundle({
  projectRoot,
  addonsSource: bundle.bundlePath,
  hosts: ['android-arm64'],
  configPath
})

if (hasErrors(verification)) {
  throw new Error(formatVerifyBundleResult(verification))
}

const bundleModule = await fs.readFile(bundle.bundlePath, 'utf8')
const bundleExportPrefix = 'module.exports = '
if (!bundleModule.startsWith(bundleExportPrefix)) {
  throw new Error('bare-pack produced an unsupported mobile bundle module')
}

const workerBundle = JSON.parse(bundleModule.slice(bundleExportPrefix.length))
if (typeof workerBundle !== 'string') {
  throw new Error('bare-pack mobile bundle did not export a string')
}
await fs.writeFile(path.join(assetsDirectory, 'worker.bundle'), workerBundle)
const runtimeAssets = [
  fs.copyFile(path.join(sdkRoot, 'LICENSE'), path.join(assetsDirectory, 'LICENSE')),
  fs.copyFile(path.join(sdkRoot, 'NOTICE'), path.join(assetsDirectory, 'NOTICE'))
]
if (includesClassification) {
  runtimeAssets.push(
    fs.copyFile(
      classificationWeightsSource,
      path.join(classificationAssetsDirectory, 'mobilenetv3_3class_v3_fp16.gguf')
    )
  )
}
await Promise.all(runtimeAssets)

const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'))
const sdkPackagePath = bundleSdkPath
  ? path.join(bundleSdkPath, 'package.json')
  : path.join(projectRoot, 'node_modules', '@qvac', 'sdk', 'package.json')
const sdkPackage = JSON.parse(await fs.readFile(sdkPackagePath, 'utf8'))
const addons = Array.isArray(manifest.addons) ? manifest.addons : []
const packageFilter =
  addons.length === 0
    ? { name: 'qvac-kotlin-no-addons', version: '0.0.0', dependencies: {} }
    : {
        name: 'qvac-kotlin-addon-linker',
        version: '0.0.0',
        dependencies: Object.fromEntries(addons.map((name) => [name, '*']))
      }

const linkedResources = new Set()
for await (const resource of link(
  modulesRoot,
  {
    hosts: ['android-arm64'],
    out: addonsDirectory
  },
  packageFilter
)) {
  linkedResources.add(path.resolve(String(resource)))
  console.log(`Linked ${resource}`)
}

// bare-link from the bundled SDK reaches the meta packages. Split addons
// keep their binaries in a per-platform package, so link each installed one
// from its own `addon` directory or its .so never reaches the AAR.
for (const platformAddon of platformAddonRoots(addons, 'android-arm64', modulesRoot)) {
  for await (const resource of link(
    platformAddon.dir,
    {
      hosts: ['android-arm64'],
      out: addonsDirectory
    },
    platformAddon.pkg
  )) {
    linkedResources.add(path.resolve(String(resource)))
    console.log(`Linked ${resource}`)
  }
}

async function sha256(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
}

const linkedAddons = []
for (const resource of [...linkedResources].sort()) {
  linkedAddons.push({
    name: path.basename(resource),
    sha256: await sha256(resource)
  })
}

// Record the resolved @qvac versions so a rebuild of the same profile is
// diffable: the addon hashes alone don't reveal an npm range that drifted.
const resolvedDependencies = {}
for (const name of ['@qvac/sdk', '@qvac/inference', ...addons].sort()) {
  const version =
    name === '@qvac/sdk' && sdkPackage.version ? sdkPackage.version : await readInstalledVersion(name)
  if (version !== null) resolvedDependencies[name] = version
  const platformPackage = platformPackageForInstalledMeta(name, 'android-arm64')
  if (platformPackage !== null) {
    const platformVersion = await readInstalledVersion(platformPackage)
    if (platformVersion !== null) resolvedDependencies[platformPackage] = platformVersion
  }
}

await fs.writeFile(
  path.join(assetsDirectory, 'profile.json'),
  `${JSON.stringify(
    {
      name: profileName,
      sdkVersion: sdkPackage.version,
      capabilities,
      plugins: qvacConfig.plugins ?? [],
      workerSha256: createHash('sha256').update(workerBundle).digest('hex'),
      resolvedDependencies,
      resources: includesClassification
        ? [
            {
              name: 'classification/mobilenetv3_3class_v3_fp16.gguf',
              sha256: await sha256(classificationWeightsSource)
            }
          ]
        : [],
      addons: linkedAddons
    },
    null,
    2
  )}\n`
)

console.log(`Prepared QVAC Android runtime with ${addons.length} addon(s)`)

function ensureWorkspaceSdk(sdkDir) {
  if (!fsSync.existsSync(path.join(sdkDir, 'package.json'))) return undefined
  const worker = path.join(sdkDir, 'dist', 'src', 'worker', 'index.js')
  if (!fsSync.existsSync(worker)) {
    execFileSync('python3', [path.join(sdkDir, '..', 'sdk-python', 'scripts', 'build_worker.py')], {
      stdio: 'inherit'
    })
  }
  return sdkDir
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * The installed platform-package `addon` directories for the given metas, ready
 * for a bare-link pass. Mirrors `resolvePlatformAddonRoots` in the Expo linker.
 */
function packageDir(modulesRoot, name) {
  return path.join(modulesRoot, 'node_modules', ...name.split('/'))
}

function classificationWeightsPath(modulesRoot) {
  const weights = path.join('weights', 'mobilenetv3_3class_v3_fp16.gguf')
  const bundled = path.join(packageDir(modulesRoot, '@qvac/classification-ggml'), weights)
  if (fsSync.existsSync(bundled)) return bundled
  return path.join(packageDir(projectRoot, '@qvac/classification-ggml'), weights)
}

function platformAddonRoots(addonNames, host, modulesRoot) {
  const roots = []
  for (const name of addonNames) {
    const metaPath = path.join(packageDir(modulesRoot, name), 'package.json')
    let meta
    try {
      meta = JSON.parse(fsSync.readFileSync(metaPath, 'utf8'))
    } catch {
      continue
    }
    const platformPackage = platformPackageForHost(meta, host)
    if (platformPackage === null) continue
    const addonDir = path.join(packageDir(modulesRoot, platformPackage), 'addon')
    let addonManifest
    try {
      addonManifest = JSON.parse(fsSync.readFileSync(path.join(addonDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (addonManifest.addon !== true) continue
    if (!fsSync.existsSync(path.join(addonDir, 'prebuilds'))) continue
    roots.push({ dir: addonDir, pkg: addonManifest })
  }
  return roots
}

async function readInstalledVersion(packageName) {
  try {
    const meta = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json'),
        'utf8'
      )
    )
    return typeof meta.version === 'string' ? meta.version : null
  } catch {
    return null
  }
}

/** The platform package for an installed meta, or null when the meta has no host map. */
function platformPackageForInstalledMeta(metaName, host) {
  try {
    const meta = JSON.parse(
      fsSync.readFileSync(
        path.join(projectRoot, 'node_modules', ...metaName.split('/'), 'package.json'),
        'utf8'
      )
    )
    return platformPackageForHost(meta, host)
  } catch {
    return null
  }
}

/** The platform prebuild package an addon's `#host-addon` map names for a host. */
function platformPackageForHost(meta, host) {
  const dash = host.indexOf('-')
  const platform = host.slice(0, dash)
  const arch = host.slice(dash + 1)
  const hostMap = meta.imports?.['#host-addon']?.[platform]
  if (hostMap === undefined) return null
  const entry = Array.isArray(hostMap) ? hostMap : hostMap[arch]
  const candidate = Array.isArray(entry) ? entry[0] : entry
  return typeof candidate === 'string' && candidate.startsWith('@') ? candidate : null
}

/**
 * Install the per-platform prebuild packages the bundled addons need for `host`,
 * derived from each addon's own `#host-addon` map at the meta's installed
 * version. Installed beside that meta, not recorded in package.json.
 */
async function ensureHostPrebuilds(manifestPath, host, modulesRoot) {
  const manifestJson = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const manifestAddons = Array.isArray(manifestJson.addons) ? manifestJson.addons : []
  const specs = []
  for (const addon of manifestAddons) {
    const addonRoot = packageDir(modulesRoot, addon)
    // A local fat `prebuilds/<host>` already resolves; only a meta without one
    // needs its per-platform package installed.
    if (await pathExists(path.join(addonRoot, 'prebuilds', host))) continue
    let meta
    try {
      meta = JSON.parse(await fs.readFile(path.join(addonRoot, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const platformPackage = platformPackageForHost(meta, host)
    if (platformPackage !== null && typeof meta.version === 'string') {
      specs.push(`${platformPackage}@${meta.version}`)
    }
  }
  if (specs.length === 0) return
  console.log(`Installing ${host} prebuild packages: ${specs.join(', ')}`)
  await installPrebuilds(modulesRoot, specs)
}

async function installPrebuilds(modulesRoot, specs) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'qvac-android-prebuilds-'))
  try {
    await fs.writeFile(path.join(staging, 'package.json'), '{"private":true}\n')
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', '--legacy-peer-deps', ...specs],
      { cwd: staging, stdio: 'inherit' }
    )
    for (const spec of specs) {
      const name = spec.slice(0, spec.lastIndexOf('@'))
      await fs.cp(packageDir(staging, name), packageDir(modulesRoot, name), {
        recursive: true,
        force: true
      })
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}
