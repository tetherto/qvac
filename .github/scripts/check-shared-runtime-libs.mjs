#!/usr/bin/env node
/**
 * Fail if installing a package together with all of its @qvac peers resolves
 * @qvac/infer-base, @qvac/logging, or @qvac/error to more than one version.
 *
 * Only the dependency tree is resolved (npm --package-lock-only against a
 * tarball holding just package.json), so no build or prebuild download is
 * needed.
 *
 * Usage:
 *   node .github/scripts/check-shared-runtime-libs.mjs [package-dir] [--local <dir>]...
 *
 *   package-dir defaults to packages/inference. Each --local package replaces
 *   its npm release in the tree, for a dependency that is ahead of npm.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPackageJson, resolveConsumerLockfile } from './lib/consumer-lockfile.mjs'
import {
  buildConsumerManifest,
  collectResolvedVersions,
  findDuplicates,
  formatDuplicates,
  formatResolved,
} from './lib/shared-runtime-libs.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function parseArgs(argv) {
  const args = { packageDir: 'packages/inference', local: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local') {
      if (!argv[i + 1]) throw new Error('--local needs a package directory')
      args.local.push(argv[++i])
    } else if (argv[i].startsWith('-')) {
      throw new Error(`unknown argument: ${argv[i]}`)
    } else {
      args.packageDir = argv[i]
    }
  }
  return args
}

function resolveLockfile({ packageDir, local }) {
  const pkg = readPackageJson(repoRoot, packageDir)
  const { manifest, lockfile } = resolveConsumerLockfile(repoRoot, 'shared-runtime-libs', (pack) => {
    const overrides = {}
    local.forEach((dir, index) => {
      overrides[readPackageJson(repoRoot, dir).name] = pack(dir, `local-${index}`)
    })
    return buildConsumerManifest(pkg, pack(packageDir, 'package'), overrides)
  })
  return { pkg, manifest, lockfile }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { pkg, manifest, lockfile } = resolveLockfile(args)
  const resolved = collectResolvedVersions(lockfile)

  const peers = Object.keys(manifest.dependencies).length - 1
  const localNote = manifest.overrides ? `, local ${Object.keys(manifest.overrides).join(', ')}` : ''
  console.log(`${pkg.name}@${pkg.version} with ${peers} @qvac peers${localNote}:`)
  for (const line of formatResolved(resolved)) console.log(`  ${line}`)

  const duplicates = findDuplicates(resolved)
  if (duplicates.length === 0) return

  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'error: '
  for (const line of formatDuplicates(duplicates)) console.error(`${prefix}${line}`)
  console.error('Align the package that pulls the extra copy with the range the others use.')
  process.exitCode = 1
}

main()
