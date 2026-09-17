/**
 * Resolves the inner addon directory of each installed platform package.
 *
 * A split addon ships JavaScript in its meta package and its binaries in a
 * per-platform package, under `addon/` — and only that inner directory is
 * marked `addon: true`. `bare-link` walks dependency fields and emits a binary
 * only for a package marked that way, so it reaches the meta (no `prebuilds/`
 * since the split) and never the binaries. Linking the inner directory directly
 * restores the pre-split output, whose name is derived from the meta package
 * name it carries.
 *
 * This file is copied next to the patched link.mjs by withMobileBundle.ts.
 */
import fs from 'fs'
import path from 'path'

const HOST_ADDON_IMPORT = '#host-addon'

export function resolvePlatformAddonRoots(projectRoot, addonNames, platform) {
  const roots = []
  for (const name of addonNames) {
    const root = resolvePlatformAddonRoot(projectRoot, name, platform)
    if (root !== null) roots.push(root)
  }
  return roots
}

function resolvePlatformAddonRoot(projectRoot, metaName, platform) {
  const metaManifest = readManifest(packageDir(projectRoot, metaName))
  if (metaManifest === null) return null

  const platformPackage = platformPackageName(metaManifest.imports?.[HOST_ADDON_IMPORT], platform)
  if (platformPackage === null || !platformPackage.startsWith(`${metaName}-`)) return null

  const addonDir = path.join(packageDir(projectRoot, platformPackage), 'addon')
  const addonManifest = readManifest(addonDir)
  if (addonManifest === null || addonManifest.addon !== true) return null
  if (!fs.existsSync(path.join(addonDir, 'prebuilds'))) return null

  return { dir: addonDir, pkg: addonManifest }
}

function packageDir(projectRoot, packageName) {
  return path.join(projectRoot, 'node_modules', ...packageName.split('/'))
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function platformPackageName(hostAddon, platform) {
  const branch = readBranch(hostAddon, platform)
  const candidate = platform === 'android' ? readBranch(branch, 'arm64') : branch
  const name = Array.isArray(candidate) ? candidate[0] : candidate
  if (typeof name !== 'string' || name.startsWith('.')) return null
  return name
}

function readBranch(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value[key]
}
