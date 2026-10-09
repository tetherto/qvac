import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bundleSdk, formatVerifyBundleResult, hasErrors, verifyBundle } from '@qvac/sdk/commands'
import link from 'bare-link'
import { platformPackageForHost } from './platform-package.mjs'

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
  ['@qvac/sdk/llamacpp-decision/plugin', ['DECISION']],
  ['@qvac/sdk/whispercpp-transcription/plugin', ['TRANSCRIPTION']],
  ['@qvac/sdk/parakeet-transcription/plugin', ['TRANSCRIPTION']],
  ['@qvac/sdk/moss-transcribe/plugin', ['TRANSCRIPTION']],
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

// Split addons ship their native code in per-platform packages, installed at
// each meta's version before bundling.
await ensureHostPrebuilds('android-arm64', modulesRoot)

// Resolve addons, prebuilds and the bundle from the tree the worker is built
// from: the workspace SDK when present, else the installed @qvac/sdk. These
// differ in the monorepo, where the worker comes from ../sdk but the Kotlin
// runtime's own node_modules is a separate tree; for a standalone consumer they
// are the same. ensureHostPrebuilds installs into this tree too.
const bundle = await bundleSdk({
  projectRoot: modulesRoot,
  configPath,
  ...(bundleSdkPath !== undefined && { sdkPath: bundleSdkPath }),
  hosts: ['android-arm64'],
  defer: ['react-native-bare-kit', '@qvac/sdk/worker.mobile.bundle'],
  quiet: true
})

const verification = await verifyBundle({
  projectRoot: modulesRoot,
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

// bare-link 4 links the addons the worker entry's module graph loads on the
// host, resolving each meta's per-platform split package (installed above by
// ensureHostPrebuilds) in one pass. It rewrites existing DT_NEEDED entries
// rather than adding one per installed addon, so the split @qvac/fabric layout
// links a single libqvac__fabric-android-arm64.
const linkedResources = new Set()
for await (const resource of link(bundle.entryPaths.worker, {
  hosts: ['android-arm64'],
  out: addonsDirectory
})) {
  linkedResources.add(path.resolve(String(resource)))
  console.log(`Linked ${resource}`)
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

function packageDir(modulesRoot, name) {
  return path.join(modulesRoot, 'node_modules', ...name.split('/'))
}

function classificationWeightsPath(modulesRoot) {
  const weights = path.join('weights', 'mobilenetv3_3class_v3_fp16.gguf')
  const bundled = path.join(packageDir(modulesRoot, '@qvac/classification-ggml'), weights)
  if (fsSync.existsSync(bundled)) return bundled
  return path.join(packageDir(projectRoot, '@qvac/classification-ggml'), weights)
}

async function readInstalledVersion(packageName, root = projectRoot) {
  try {
    const meta = JSON.parse(
      await fs.readFile(
        path.join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
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

/**
 * Install the per-platform packages every split addon under `modulesRoot`
 * names for `host` in its `#host-addon` map, at the meta's installed version.
 * Consumers declare the mobile ones as optional peers, which npm does not
 * install. Installed into `modulesRoot`, which bare-pack's lookup from any
 * package under it reaches, and not recorded in package.json.
 */
async function ensureHostPrebuilds(host, modulesRoot) {
  const specs = new Set()
  for (const meta of await installedQvacPackages(modulesRoot)) {
    const platformPackage = platformPackageForHost(meta, host)
    if (platformPackage === null || typeof meta.version !== 'string') continue
    if ((await readInstalledVersion(platformPackage, modulesRoot)) === meta.version) continue
    specs.add(`${platformPackage}@${meta.version}`)
  }
  if (specs.size === 0) return
  console.log(`Installing ${host} platform packages: ${[...specs].join(', ')}`)
  await installPrebuilds(modulesRoot, [...specs])
}

/**
 * The @qvac packages reachable from `modulesRoot`'s dependencies, found the way
 * bare-pack resolves them: up the (unresolved) symlinked path, so a pnpm
 * layout's transitive addons (fabric under its consumers) are included.
 */
async function installedQvacPackages(modulesRoot) {
  const found = new Map()
  const queue = [modulesRoot]
  while (queue.length > 0) {
    const dir = queue.shift()
    let pkg
    try {
      pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const names = Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies
    }).filter((name) => name.startsWith('@qvac/'))
    for (const name of names) {
      const depDir = lookupPackageDir(dir, name)
      if (depDir === null || found.has(depDir)) continue
      try {
        found.set(depDir, JSON.parse(await fs.readFile(path.join(depDir, 'package.json'), 'utf8')))
      } catch {
        continue
      }
      queue.push(depDir)
    }
  }
  return [...found.values()]
}

function lookupPackageDir(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'))
    if (fsSync.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (path.dirname(dir) === dir) return null
  }
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
