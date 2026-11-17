// Reads the facts the release scripts share with the root Package.swift.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The exact bare-kit-swift version a manifest pins, or null. */
export function bareKitPin(manifest) {
  return /bare-kit-swift", exact: "([^"]+)"/.exec(manifest)?.[1] ?? null
}

function match(pattern, text, what) {
  const found = pattern.exec(text)
  if (!found) throw new Error(`The root Package.swift declares no ${what}`)
  return found
}

function platformVersion(platforms, name) {
  const [, major, minor] = match(new RegExp(`\\.${name}\\(\\.v(\\d+)(?:_(\\d+))?\\)`), platforms, `${name} platform`)
  return `${major}.${minor ?? '0'}`
}

/**
 * The root manifest's text, tools version, `platforms` list as written, and
 * minimum iOS and macOS versions as `major.minor`.
 */
export async function readRootManifest() {
  const text = await readFile(path.join(repoRoot, 'Package.swift'), 'utf8')
  const toolsVersion = match(/^\/\/ swift-tools-version: *(\S+)/, text, 'swift-tools-version')[1]
  const platforms = match(/platforms: (\[[^\]]*\])/, text, 'platforms')[1]
  return {
    text,
    toolsVersion,
    platforms,
    ios: platformVersion(platforms, 'iOS'),
    macos: platformVersion(platforms, 'macOS')
  }
}
