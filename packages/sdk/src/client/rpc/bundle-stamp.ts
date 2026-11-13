import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The field `bundleSdk` sets in a bundled worker's package.json to the `@qvac/sdk` version that bundled it. */
export const BUNDLED_SDK_VERSION_FIELD = 'qvacSdkVersion'

/** The field `bundleSdk` sets in a bundled worker's package.json to the target it bundled for. */
export const BUNDLED_TARGET_FIELD = 'qvacTarget'

/**
 * The file `bundleSdk` writes at the root of a Kotlin or Python harness, which
 * has no package.json, with the same fields as a JavaScript harness stamp.
 */
export const BUNDLE_RECORD_FILE = 'qvac-bundle.json'

const SDK_NAME = '@qvac/sdk'

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readManifest(dir: string): Record<string, unknown> | null {
  return readJson(path.join(dir, 'package.json'))
}

/**
 * The version of the `@qvac/sdk` package above `from`, which for this module
 * is the SDK's own. Undefined when the SDK was bundled into the app.
 */
export function installedSdkVersion(
  from = path.dirname(fileURLToPath(import.meta.url))
): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const manifest = fs.existsSync(path.join(dir, 'package.json')) ? readManifest(dir) : null
    if (manifest?.['name'] === SDK_NAME) {
      return typeof manifest['version'] === 'string' ? manifest['version'] : undefined
    }
    if (path.dirname(dir) === dir) return undefined
  }
}

/**
 * A warning when the bundled worker in `dir` was bundled by another
 * `@qvac/sdk` than `installed`, or null when the versions match or the bundle
 * cannot be read.
 */
export function bundledSdkMismatch(dir: string, installed: string): string | null {
  const manifest = readManifest(dir)
  if (manifest === null) return null
  const bundled = manifest[BUNDLED_SDK_VERSION_FIELD]
  if (bundled === installed) return null

  const bundledBy = typeof bundled === 'string' ? `@qvac/sdk ${bundled}` : 'an older @qvac/sdk'
  return (
    `The worker in ${dir} was bundled by ${bundledBy}, but @qvac/sdk ${installed} is installed. ` +
    'Run `qvac bundle sdk` again so the worker matches the SDK.'
  )
}

/** The target the worker in `dir` was bundled for, or undefined when it does not say. */
export function bundledTarget(dir: string): string | undefined {
  const target = readManifest(dir)?.[BUNDLED_TARGET_FIELD]
  return typeof target === 'string' ? target : undefined
}

/**
 * The target the bundle at `bundlePath` was bundled for. A Kotlin or Python
 * harness keeps its bundle in a subfolder, so the nearest folder above it with
 * a record or a package.json says; undefined when that folder does not record it.
 */
export function bundleTargetOf(bundlePath: string): string | undefined {
  for (let dir = path.dirname(bundlePath); ; dir = path.dirname(dir)) {
    const record = readJson(path.join(dir, BUNDLE_RECORD_FILE))
    if (record !== null || fs.existsSync(path.join(dir, 'package.json'))) {
      const target = (record ?? readManifest(dir))?.[BUNDLED_TARGET_FIELD]
      return typeof target === 'string' ? target : undefined
    }
    if (path.dirname(dir) === dir) return undefined
  }
}
