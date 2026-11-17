#!/usr/bin/env node
// Builds the Swift bridge client: generates the Swift client from this checkout's SDK, bundles the
// e2e worker (fixtures/qvac.config.e2e.json) for this Mac into runners/swift/macos/QvacWorker,
// then builds the qvac-e2e-bridge executable. The `prepare` step of the swift-macos consumer in
// qvac-test.config.js.
//
//   node runners/swift/scripts/prepare.mjs     (from packages/sdk-e2e)
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleSdk } from '@qvac/sdk/commands'

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eRoot = path.resolve(runnerRoot, '..', '..')
const macosRoot = path.join(runnerRoot, 'macos')
const outputDir = path.join(macosRoot, 'QvacWorker')

execFileSync('python3', [path.resolve(e2eRoot, '..', 'sdk-swift', 'scripts', 'generate.py')], {
  stdio: 'inherit'
})
await rm(outputDir, { recursive: true, force: true })
const bundle = await bundleSdk({
  projectRoot: e2eRoot,
  configPath: path.join(e2eRoot, 'fixtures', 'qvac.config.e2e.json'),
  target: 'bare-kit',
  language: 'swift',
  outputDir,
  hosts: [`darwin-${process.arch}`],
  quiet: true
})
console.log(`Bundled the e2e worker with ${bundle.addons.length} native addons into ${outputDir}`)

// Link with this Mac's SDK version: Metal picks its shading language from it, and at 13.0 the diffusion addon's ggml kernels for FLUX do not compile, so generation crashes.
const sdkVersion = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
  encoding: 'utf8'
}).trim()
const linkerFlags = ['-platform_version', 'macos', '13.0', sdkVersion].flatMap((flag) => [
  '-Xlinker',
  flag
])
execFileSync('swift', ['build', '-c', 'release', '--product', 'qvac-e2e-bridge', ...linkerFlags], {
  cwd: macosRoot,
  stdio: 'inherit'
})
