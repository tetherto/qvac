#!/usr/bin/env node
/**
 * Fail if installing a package together with all of its optional peers
 * resolves @qvac/infer-base, @qvac/logging, or @qvac/error to more than one
 * version.
 *
 * Only the dependency tree is resolved (npm --package-lock-only against a
 * tarball holding just package.json), so no build or prebuild download is
 * needed.
 *
 * Usage: node .github/scripts/check-shared-runtime-libs.mjs [package-dir]
 *   package-dir defaults to packages/inference
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildConsumerManifest,
  collectResolvedVersions,
  findDuplicates,
  formatDuplicates,
  formatResolved,
} from './lib/shared-runtime-libs.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
}

function resolveLockfile(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'shared-runtime-libs-'))
  try {
    mkdirSync(join(workDir, 'package'))
    copyFileSync(packageJsonPath, join(workDir, 'package', 'package.json'))
    run('tar', ['-czf', 'package.tgz', 'package'], workDir)

    const manifest = buildConsumerManifest(pkg, 'file:./package.tgz')
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], workDir)

    return { pkg, lockfile: JSON.parse(readFileSync(join(workDir, 'package-lock.json'), 'utf8')) }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function main() {
  const packageDir = resolve(repoRoot, process.argv[2] ?? 'packages/inference')
  const { pkg, lockfile } = resolveLockfile(join(packageDir, 'package.json'))
  const resolved = collectResolvedVersions(lockfile)

  console.log(`${pkg.name}@${pkg.version} with ${Object.keys(pkg.peerDependencies ?? {}).length} peers:`)
  for (const line of formatResolved(resolved)) console.log(`  ${line}`)

  const duplicates = findDuplicates(resolved)
  if (duplicates.length === 0) return

  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'error: '
  for (const line of formatDuplicates(duplicates)) console.error(`${prefix}${line}`)
  console.error('Align the peer that pulls the extra copy with the range the other packages use.')
  process.exitCode = 1
}

main()
