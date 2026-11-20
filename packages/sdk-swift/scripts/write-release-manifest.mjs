#!/usr/bin/env node
// Adds the worker profiles of a release to the root Package.swift, from the
// manifest.json build-profiles.mjs wrote, with each archive at <base-url>/<file>.
// Each profile product wraps a small target, so an addon that one platform
// alone ships is linked on that platform only. Run on the release commit; the
// result is tagged, never merged.
//
//   node scripts/write-release-manifest.mjs --base-url <url>
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values: options } = parseArgs({ options: { 'base-url': { type: 'string' } } })
const baseUrl = options['base-url']?.replace(/\/$/, '')
if (!baseUrl) throw new Error('Usage: node scripts/write-release-manifest.mjs --base-url <url>')

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const manifestPath = path.join(repoRoot, 'Package.swift')
const { profiles, artifacts } = JSON.parse(
  await readFile(path.join(packageRoot, 'build', 'profiles', 'manifest.json'), 'utf8')
)

const MARKER = '// Worker profiles of this release.'
const SWIFT_PLATFORMS = { ios: '.iOS', macos: '.macOS' }

const swiftManifest = await readFile(manifestPath, 'utf8')
if (swiftManifest.includes(MARKER)) throw new Error('Package.swift already lists the worker profiles')

const products = []
const targets = []
for (const { framework, addons } of Object.values(profiles)) {
  const wrapper = `${framework}Profile`
  const wrapperPath = `packages/sdk-swift/Profiles/${framework}`
  await mkdir(path.join(repoRoot, wrapperPath), { recursive: true })
  await writeFile(path.join(repoRoot, wrapperPath, 'Profile.swift'), '')

  const everywhere = artifacts[framework].platforms.length
  const dependencies = [framework, ...addons].map((name) => {
    const { platforms } = artifacts[name]
    if (platforms.length === everywhere) return `      ${JSON.stringify(name)},`
    const when = platforms.map((platform) => SWIFT_PLATFORMS[platform]).join(', ')
    return `      .target(name: ${JSON.stringify(name)}, condition: .when(platforms: [${when}])),`
  })
  products.push(`  .library(name: ${JSON.stringify(framework)}, targets: [${JSON.stringify(wrapper)}, "QvacBareKit"]),`)
  targets.push(
    `  .target(\n    name: ${JSON.stringify(wrapper)},\n    dependencies: [\n${dependencies.join('\n')}\n    ],\n    path: ${JSON.stringify(wrapperPath)}\n  ),`
  )
}
for (const [name, { file, checksum }] of Object.entries(artifacts)) {
  targets.push(
    `  .binaryTarget(\n    name: ${JSON.stringify(name)},\n    url: ${JSON.stringify(`${baseUrl}/${file}`)},\n    checksum: ${JSON.stringify(checksum)}\n  ),`
  )
}

await writeFile(
  manifestPath,
  `${swiftManifest.trimEnd()}\n\n${MARKER}\npackage.products += [\n${products.join('\n')}\n]\npackage.targets += [\n${targets.join('\n')}\n]\n`
)
console.log(`Added ${products.length} worker profiles and ${Object.keys(artifacts).length} archives to ${manifestPath}`)
