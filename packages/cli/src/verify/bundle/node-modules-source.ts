import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  deduplicateAddons,
  readAddonPackageJson,
  type CollectDiagnostics,
  type NativeAddon
} from './addon-source.js'

export class InvalidNodeModulesSourceError extends Error {
  nodeModulesPath: string
  constructor (nodeModulesPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `node_modules at ${nodeModulesPath} could not be read.\n\n` +
      `  Reason: ${reason}\n\n` +
      '  Run `npm install` before invoking `qvac verify bundle` against a node_modules tree.'
    )
    this.name = 'InvalidNodeModulesSourceError'
    this.nodeModulesPath = nodeModulesPath
  }
}

export interface CollectAddonsFromNodeModulesOptions {
  nodeModulesRoot: string
  diagnostics?: CollectDiagnostics
}

export async function collectAddonsFromNodeModules (
  options: CollectAddonsFromNodeModulesOptions
): Promise<NativeAddon[]> {
  const { nodeModulesRoot, diagnostics } = options
  const addons: NativeAddon[] = []
  await walkNodeModules(nodeModulesRoot, addons, diagnostics, true)
  return deduplicateAddons(addons)
}

async function walkNodeModules (
  nodeModulesDir: string,
  addons: NativeAddon[],
  diagnostics: CollectDiagnostics | undefined,
  isRoot: boolean
): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(nodeModulesDir, { withFileTypes: true })
  } catch (error) {
    if (isRoot) throw new InvalidNodeModulesSourceError(nodeModulesDir, error)
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!isPackageEntry(entry)) continue

    if (entry.name.startsWith('@')) {
      await walkScopeDirectory(path.join(nodeModulesDir, entry.name), addons, diagnostics)
      continue
    }

    await visitPackageDirectory(
      path.join(nodeModulesDir, entry.name),
      entry.name,
      addons,
      diagnostics
    )
  }
}

async function walkScopeDirectory (
  scopeDir: string,
  addons: NativeAddon[],
  diagnostics: CollectDiagnostics | undefined
): Promise<void> {
  const scope = path.basename(scopeDir)
  let entries
  try {
    entries = await fsp.readdir(scopeDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!isPackageEntry(entry)) continue
    await visitPackageDirectory(
      path.join(scopeDir, entry.name),
      `${scope}/${entry.name}`,
      addons,
      diagnostics
    )
  }
}

function isPackageEntry (entry: import('node:fs').Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink()
}

async function visitPackageDirectory (
  packageDir: string,
  packageName: string,
  addons: NativeAddon[],
  diagnostics: CollectDiagnostics | undefined
): Promise<void> {
  const result = await readAddonPackageJson({
    packageJsonPath: path.join(packageDir, 'package.json'),
    expectedName: packageName
  })
  if (result.isAddon && result.addon) {
    addons.push(result.addon)
  } else if (result.invalid !== undefined && diagnostics !== undefined) {
    diagnostics.invalidPackageJsons.push(result.invalid)
  }

  const nestedNodeModules = path.join(packageDir, 'node_modules')
  await walkNodeModules(nestedNodeModules, addons, diagnostics, false)
}
