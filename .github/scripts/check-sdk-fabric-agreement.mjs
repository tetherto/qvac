#!/usr/bin/env node
/**
 * Fail if the published addons @qvac/sdk selects resolve @qvac/fabric to more
 * than one version. Addons that do not declare @qvac/fabric are skipped.
 *
 * The SDK is installed from its package.json alone, as a consumer would, so
 * the check sees the addon versions npm picks for the committed ranges.
 *
 * Usage:
 *   node .github/scripts/check-sdk-fabric-agreement.mjs [package-dir]
 *
 *   package-dir defaults to packages/sdk.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageJson, resolveConsumerLockfile } from './lib/consumer-lockfile.mjs'
import {
  FABRIC,
  collectAddonFabric,
  findFabricConflict,
  formatAddon,
  formatConflict,
  sdkQvacDependencies,
} from './lib/sdk-fabric-agreement.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function main() {
  const packageDir = process.argv[2] ?? 'packages/sdk'
  const pkg = readPackageJson(repoRoot, packageDir)
  const { lockfile } = resolveConsumerLockfile(repoRoot, 'sdk-fabric-agreement', (pack) => ({
    name: 'sdk-fabric-agreement-check',
    version: '0.0.0',
    private: true,
    dependencies: { [pkg.name]: pack(packageDir, 'package') },
  }))

  const addons = collectAddonFabric(lockfile, pkg.name, sdkQvacDependencies(pkg))
  console.log(`${pkg.name}@${pkg.version}: ${addons.length} selected addons declare ${FABRIC}`)
  for (const addon of addons) console.log(`  ${formatAddon(addon)}`)

  const conflict = findFabricConflict(addons)
  if (conflict.length === 0) return

  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'error: '
  console.error(`${prefix}SDK addons resolve ${FABRIC} to ${conflict.length} versions`)
  for (const line of formatConflict(conflict)) console.error(`${prefix}${line}`)
  console.error(`Align the SDK's addon ranges on one ${FABRIC} line.`)
  process.exitCode = 1
}

main()
