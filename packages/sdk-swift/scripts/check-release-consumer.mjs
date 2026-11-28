#!/usr/bin/env node
// Builds a throwaway package that depends on a Swift package release the way an
// app does, by URL and exact version, with every worker profile product of
// build/profiles/manifest.json, for the iOS simulator and for macOS. A
// dynamic library links each profile's frameworks, so a wrong checksum, a
// missing archive or an unresolved addon fails here.
//
//   node scripts/check-release-consumer.mjs --package <git url> --version <version>
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readManifest } from './manifest.mjs'

const { values: options } = parseArgs({
  options: { package: { type: 'string' }, version: { type: 'string' } }
})
if (!options.package || !options.version) {
  throw new Error('Usage: node scripts/check-release-consumer.mjs --package <git url> --version <version>')
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const consumer = path.join(packageRoot, 'build', 'consumer')
const identity = path.basename(new URL(options.package).pathname).replace(/\.git$/, '').toLowerCase()
const { profiles } = JSON.parse(await readFile(path.join(packageRoot, 'build', 'profiles', 'manifest.json'), 'utf8'))
const frameworks = Object.values(profiles).map((profile) => profile.framework)
const { toolsVersion, platforms } = await readManifest()

const products = ['QvacSDK', 'QvacBareKit', ...frameworks]
  .map((name) => `        .product(name: ${JSON.stringify(name)}, package: ${JSON.stringify(identity)}),`)
  .join('\n')

await rm(consumer, { recursive: true, force: true })
await mkdir(path.join(consumer, 'Sources', 'Consumer'), { recursive: true })
await writeFile(
  path.join(consumer, 'Package.swift'),
  `// swift-tools-version: ${toolsVersion}
import PackageDescription

let package = Package(
  name: "Consumer",
  platforms: ${platforms},
  products: [.library(name: "Consumer", type: .dynamic, targets: ["Consumer"])],
  dependencies: [.package(url: ${JSON.stringify(options.package)}, exact: ${JSON.stringify(options.version)})],
  targets: [
    .target(
      name: "Consumer",
      dependencies: [
${products}
      ]
    )
  ]
)
`
)
await writeFile(
  path.join(consumer, 'Sources', 'Consumer', 'Consumer.swift'),
  `import Foundation
import QvacBareKit
import QvacSDK

public func start(_ profile: QvacWorkerProfile, homeDirectory: URL) async throws -> QvacClient {
  try await QvacClient.start(profile: profile, homeDirectory: homeDirectory)
}
`
)

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: consumer, stdio: 'inherit' })
}

run('xcodebuild', [
  '-scheme', 'Consumer',
  '-destination', 'generic/platform=iOS Simulator',
  '-derivedDataPath', path.join(consumer, '.derived'),
  '-quiet',
  'build'
])
run('swift', ['build'])
console.log(`\n${options.package} ${options.version} resolves and links ${frameworks.length} worker profiles on iOS and macOS`)
