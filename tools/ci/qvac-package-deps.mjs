#!/usr/bin/env node
/**
 * Root-level dependency manifest for QVAC workspace packages.
 *
 * Source of truth: package.json → qvac.packages[<npm name>]
 * Sync copies dependencies/devDependencies into the package package.json
 * so pnpm install and pnpm pack see only that package's dependency graph.
 *
 * Usage:
 *   node tools/ci/qvac-package-deps.mjs sync      # write package.json deps from root
 *   node tools/ci/qvac-package-deps.mjs validate  # fail if package.json is out of sync
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

function readJson (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sortedEntries (obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  )
}

function loadRootManifest () {
  const root = readJson(resolve(repoRoot, 'package.json'))
  const packages = root.qvac?.packages
  if (!packages || typeof packages !== 'object') {
    throw new Error('Missing qvac.packages in root package.json')
  }
  return packages
}

function syncPackage (npmName, manifest, { dryRun = false } = {}) {
  if (!manifest.path) {
    throw new Error(`qvac.packages["${npmName}"] is missing "path"`)
  }

  const pkgPath = resolve(repoRoot, manifest.path, 'package.json')
  const pkg = readJson(pkgPath)

  const next = {
    ...pkg,
    dependencies: sortedEntries(manifest.dependencies),
    devDependencies: sortedEntries(manifest.devDependencies)
  }

  const currentDeps = sortedEntries(pkg.dependencies)
  const currentDevDeps = sortedEntries(pkg.devDependencies)
  const nextDeps = next.dependencies
  const nextDevDeps = next.devDependencies

  const inSync =
    JSON.stringify(currentDeps) === JSON.stringify(nextDeps) &&
    JSON.stringify(currentDevDeps) === JSON.stringify(nextDevDeps)

  if (!dryRun && !inSync) {
    writeFileSync(pkgPath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`Synced dependencies for ${npmName} → ${manifest.path}/package.json`)
  }

  return { inSync, pkgPath, npmName }
}

function syncAll ({ dryRun = false } = {}) {
  const manifests = loadRootManifest()
  const results = []

  for (const [npmName, manifest] of Object.entries(manifests)) {
    results.push(syncPackage(npmName, manifest, { dryRun }))
  }

  return results
}

function validateAll () {
  const results = syncAll({ dryRun: true })
  const drift = results.filter((result) => !result.inSync)

  if (drift.length > 0) {
    for (const { npmName, pkgPath } of drift) {
      console.error(
        `::error title=Package manifest drift::${npmName} package.json is out of sync with root qvac.packages. Run: node tools/ci/qvac-package-deps.mjs sync`
      )
      console.error(`  Path: ${pkgPath}`)
    }
    process.exit(1)
  }

  console.log('All workspace package manifests are in sync with root qvac.packages')
}

const command = process.argv[2] ?? 'validate'

if (command === 'sync') {
  syncAll()
} else if (command === 'validate') {
  validateAll()
} else {
  console.error(`Unknown command: ${command}`)
  console.error('Usage: qvac-package-deps.mjs <sync|validate>')
  process.exit(1)
}
