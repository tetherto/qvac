import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatAddonId, type NativeAddon } from './addon-source.js'

export interface MissingPrebuildIssue {
  code: 'missing-prebuild'
  level: 'error'
  addon: string
  host: string
  message: string
  packageRoot: string
}

export interface CheckPrebuildsOptions {
  addon: NativeAddon
  hosts: string[]
}

export async function checkPrebuilds (
  options: CheckPrebuildsOptions
): Promise<MissingPrebuildIssue[]> {
  const { addon, hosts } = options
  const issues: MissingPrebuildIssue[] = []

  for (const host of hosts) {
    const hostDir = path.join(addon.packageRoot, 'prebuilds', host)
    const present = await hasBarePrebuild(hostDir)
    if (!present) {
      issues.push({
        code: 'missing-prebuild',
        level: 'error',
        addon: formatAddonId(addon),
        host,
        packageRoot: addon.packageRoot,
        message:
          `${formatAddonId(addon)} is missing a prebuild for ${host} ` +
          `(expected ${path.join(hostDir, '*.bare')}).`
      })
    }
  }

  return issues
}

async function hasBarePrebuild (hostDir: string): Promise<boolean> {
  let entries
  try {
    entries = await fsp.readdir(hostDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (entry.name.endsWith('.bare')) return true
  }
  return false
}
