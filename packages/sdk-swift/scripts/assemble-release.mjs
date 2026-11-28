#!/usr/bin/env node
// Fills <out> with the Swift package of a release, as tetherto/qvac-sdk-swift
// publishes it: this package's sources and tests, and its Package.swift with the
// worker profiles of build/profiles/manifest.json, each archive at
// <base-url>/<file>. Each profile product wraps a small target, so an addon that
// one platform alone ships is linked on that platform only. Everything in <out>
// but .git is replaced.
//
//   node scripts/assemble-release.mjs --base-url <url> --out <dir>
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { manifestPath, packageRoot } from './manifest.mjs'

const { values: options } = parseArgs({
  options: { 'base-url': { type: 'string' }, out: { type: 'string' } }
})
const baseUrl = options['base-url']?.replace(/\/$/, '')
if (!baseUrl || !options.out) {
  throw new Error('Usage: node scripts/assemble-release.mjs --base-url <url> --out <dir>')
}
const out = path.resolve(options.out)
const repoRoot = path.resolve(packageRoot, '..', '..')

const { profiles, artifacts } = JSON.parse(
  await readFile(path.join(packageRoot, 'build', 'profiles', 'manifest.json'), 'utf8')
)

const MARKER = '// Worker profiles of this release.'
const SWIFT_PLATFORMS = { ios: '.iOS', macos: '.macOS' }

await mkdir(out, { recursive: true })
for (const entry of await readdir(out)) {
  if (entry !== '.git') await rm(path.join(out, entry), { recursive: true, force: true })
}
for (const dir of ['Sources', 'Tests']) {
  await cp(path.join(packageRoot, dir), path.join(out, dir), { recursive: true })
}
await cp(path.join(packageRoot, 'release', 'README.md'), path.join(out, 'README.md'))
await cp(path.join(repoRoot, 'LICENSE'), path.join(out, 'LICENSE'))

const products = []
const targets = []
for (const { framework, addons } of Object.values(profiles)) {
  const wrapper = `${framework}Profile`
  const wrapperPath = `Profiles/${framework}`
  await mkdir(path.join(out, wrapperPath), { recursive: true })
  await writeFile(path.join(out, wrapperPath, 'Profile.swift'), '')

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

const swiftManifest = await readFile(manifestPath, 'utf8')
await writeFile(
  path.join(out, 'Package.swift'),
  `${swiftManifest.trimEnd()}\n\n${MARKER}\npackage.products += [\n${products.join('\n')}\n]\npackage.targets += [\n${targets.join('\n')}\n]\n`
)
console.log(`Assembled ${out} with ${products.length} worker profiles and ${Object.keys(artifacts).length} archives`)
