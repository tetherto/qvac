import Bundle from 'bare-bundle'
import stow from 'bare-stow'
import reactNativeTarget from 'bare-stow-target-react-native'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const harnessReactNativeHosts = [...readTargetHosts()] as const

export interface HarnessReactNativeDescriptor {
  readonly entryPath: string
  readonly harnessPath: string
  readonly metadataPath: string
  readonly contract: 'qvac.harness'
  readonly protocolVersion: 1
  readonly hosts: readonly string[]
}

interface ReactNativeBundleMetadata {
  readonly bundleId: string | null
  readonly contract: 'qvac.harness'
  readonly protocolVersion: 1
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly string[]
  readonly packages: readonly BundledPackageIdentity[]
}

interface BundledPackageIdentity {
  readonly name: string
  readonly version: string
  readonly packagePath: string
  readonly singleton: boolean
}

interface BuildHarnessReactNativeBundleOptions {
  readonly outputDirectory?: string
}

export function createHarnessReactNativeDescriptor(): HarnessReactNativeDescriptor {
  const require = createRequire(import.meta.url)
  const packageRoot = path.dirname(require.resolve('@qvac/harness/package'))
  const generatedDirectory = path.join(packageRoot, 'generated', 'react-native')
  return {
    entryPath: path.join(packageRoot, 'mobile-entry.ts'),
    harnessPath: path.join(generatedDirectory, 'harness.js'),
    metadataPath: path.join(generatedDirectory, 'harness.metadata.json'),
    contract: 'qvac.harness',
    protocolVersion: 1,
    hosts: harnessReactNativeHosts
  }
}

export async function buildHarnessReactNativeBundle({
  outputDirectory
}: BuildHarnessReactNativeBundleOptions = {}) {
  const descriptor = createHarnessReactNativeDescriptor()
  const buildDirectory =
    outputDirectory ?? path.dirname(descriptor.harnessPath)
  const harnessPath = path.join(buildDirectory, 'harness.js')
  const metadataPath = path.join(buildDirectory, 'harness.metadata.json')
  await mkdir(buildDirectory, { recursive: true })
  const artifactPaths: string[] = []
  for await (const artifact of stow(
    pathToFileURL(descriptor.entryPath).href,
    reactNativeTarget,
    pathToFileURL(harnessPath).href
  )) {
    artifactPaths.push(fileURLToPath(artifact.url.href))
  }
  const bundlePath = artifactPaths.find((value) => value.endsWith('.bundle.mjs'))
  if (!bundlePath) {
    throw new Error('Harness react-native stow did not emit .bundle.mjs')
  }

  const bundleSource = await readFile(bundlePath, 'utf8')
  const bundle = Bundle.from(readStowBundleExport(bundleSource))
  const nativeAddons = readBundleAddons(bundle)
  await patchGeneratedHarness(harnessPath)
  const metadata: ReactNativeBundleMetadata = {
    bundleId: bundle.id ? String(bundle.id) : null,
    contract: descriptor.contract,
    protocolVersion: descriptor.protocolVersion,
    hosts: descriptor.hosts,
    nativeAddons,
    packages: readBundlePackages(bundle)
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return {
    descriptor: {
      ...descriptor,
      harnessPath,
      metadataPath
    },
    bundlePath,
    metadata
  }
}

function readStowBundleExport(source: string) {
  const prefix = 'export default '
  if (!source.startsWith(prefix)) {
    throw new Error('Stow bundle module did not export a default value')
  }
  const literal = source.slice(prefix.length).trim().replace(/;$/, '')
  const parsed: unknown = JSON.parse(literal)
  if (typeof parsed !== 'string') {
    throw new Error('Stow bundle module default export was not a string')
  }
  return parsed
}

function readTargetHosts() {
  const value = Reflect.get(reactNativeTarget as object, 'hosts')
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('React Native target did not expose hosts[]')
  }
  return value as string[]
}

function readBundleAddons(bundle: Bundle) {
  const addons = Reflect.get(bundle as object, 'addons')
  if (!Array.isArray(addons)) return []
  return addons
    .filter((entry): entry is string => typeof entry === 'string')
    .sort()
}

function readBundlePackages(bundle: Bundle) {
  const files = Reflect.get(bundle as object, 'files')
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return []
  const packages: BundledPackageIdentity[] = []
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith('/package.json') || typeof file !== 'object' || file === null) {
      continue
    }
    const data = Reflect.get(file, '_data')
    if (!(data instanceof Uint8Array)) continue
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const name = Reflect.get(parsed, 'name')
    const version = Reflect.get(parsed, 'version')
    if (typeof name !== 'string' || typeof version !== 'string') continue
    packages.push({
      name,
      version,
      packagePath,
      singleton: Reflect.get(parsed, 'addon') === true
    })
  }
  return packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.packagePath.localeCompare(right.packagePath)
  )
}

async function patchGeneratedHarness(harnessPath: string) {
  const original = await readFile(harnessPath, 'utf8')
  const withStartSignature = original.replace(
    'async start(opts = {}) {',
    'async start(opts = {}, args = []) {'
  )
  // The generated module carries the bundle as a JS string. Handing that
  // straight to BareKit makes it size a copy from UTF-16 length while writing
  // UTF-8 bytes, so any character above U+00FF overruns the buffer by the
  // difference. Encode once, here, so the worklet receives exact bytes.
  const patched = withStartSignature.replace(
    "worklet.start('/core.bundle', bundle)",
    "worklet.start('/core.bundle', new TextEncoder().encode(bundle), args)"
  )
  if (patched === original || withStartSignature === original) {
    throw new Error(`Unable to patch generated harness argv support: ${harnessPath}`)
  }
  await writeFile(harnessPath, patched)
  const typePath = harnessPath.replace(/\.js$/, '.d.ts')
  const types = await readFile(typePath, 'utf8')
  const patchedTypes = patchHarnessDeclaration(types)
  if (patchedTypes === types) {
    throw new Error(`Unable to patch generated harness declaration argv support: ${typePath}`)
  }
  await writeFile(typePath, patchedTypes)
}

function patchHarnessDeclaration(types: string) {
  const directImportPattern =
    /start\(opts\?: import\('react-native-bare-kit'\)\.WorkletOptions\): Promise<\{/g
  if (directImportPattern.test(types)) {
    return types.replace(
      directImportPattern,
      "start(opts?: import('react-native-bare-kit').WorkletOptions, args?: readonly string[]): Promise<{"
    )
  }
  const localTypePattern = /start\(opts\?: WorkletOptions\): Promise<\{/g
  if (localTypePattern.test(types)) {
    return types.replace(
      localTypePattern,
      'start(opts?: WorkletOptions, args?: readonly string[]): Promise<{'
    )
  }
  return types
}
