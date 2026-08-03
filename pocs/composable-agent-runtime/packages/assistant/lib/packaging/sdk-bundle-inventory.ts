import Bundle from 'bare-bundle'
import { access, readFile } from 'node:fs/promises'
import type { PackageInstance } from '../artifact-validation.ts'

export async function readSdkBundlePackages(bundlePath: string) {
  try {
    await access(bundlePath)
  } catch {
    return null
  }
  const source = await readFile(bundlePath)
  const text = source.toString('utf8')
  const prefix = 'module.exports = '
  const bundle = text.startsWith(prefix)
    ? decodeExportedBundle(text, prefix, bundlePath)
    : decodeBundle(source, bundlePath)
  const files = Reflect.get(bundle as object, 'files')
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    throw new Error(`SDK bundle omitted file inventory: ${bundlePath}`)
  }
  const packages: PackageInstance[] = []
  for (const [packagePath, file] of Object.entries(files)) {
    if (!packagePath.endsWith('/package.json') || typeof file !== 'object' || file === null) {
      continue
    }
    const data = Reflect.get(file, '_data')
    if (!(data instanceof Uint8Array)) continue
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'))
    if (!isObject(parsed) || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      continue
    }
    packages.push({
      name: parsed.name,
      version: parsed.version,
      packagePath,
      singleton: parsed.addon === true
    })
  }
  if (packages.length === 0) {
    throw new Error(`SDK bundle contained no package manifests: ${bundlePath}`)
  }
  return packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.packagePath.localeCompare(right.packagePath)
  )
}

function decodeExportedBundle(source: string, prefix: string, bundlePath: string) {
  const literal = source.slice(prefix.length).trim().replace(/;$/, '')
  const encoded: unknown = JSON.parse(literal)
  if (typeof encoded !== 'string') {
    throw new Error(`SDK bundle wrapper did not export a string: ${bundlePath}`)
  }
  return Bundle.from(encoded)
}

function decodeBundle(data: Uint8Array, bundlePath: string) {
  const from = Reflect.get(Bundle, 'from')
  if (typeof from !== 'function') {
    throw new Error('bare-bundle did not expose Bundle.from')
  }
  const decoded: unknown = Reflect.apply(from, Bundle, [data])
  if (!(decoded instanceof Bundle)) {
    throw new Error(`Unable to decode SDK bundle: ${bundlePath}`)
  }
  return decoded
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
