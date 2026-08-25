import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatAddonId, type NativeAddon } from '@/commands/verify/addon-source'

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

export async function checkPrebuilds(
  options: CheckPrebuildsOptions
): Promise<MissingPrebuildIssue[]> {
  const { addon, hosts } = options
  const issues: MissingPrebuildIssue[] = []

  for (const host of hosts) {
    const hostDir = path.join(addon.packageRoot, 'prebuilds', host)
    const present = (await listBarePrebuildFiles(hostDir)).length > 0
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

export async function listBarePrebuildFiles(hostDir: string): Promise<string[]> {
  let entries
  try {
    entries = await fsp.readdir(hostDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.bare'))
    .map((entry) => path.resolve(hostDir, entry.name))
    .sort()
}
