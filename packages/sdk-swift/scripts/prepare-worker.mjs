#!/usr/bin/env node
// Bundles this checkout's worker for an app folder: reads <app>/qvac.config.json
// and writes the Swift package <app>/QvacWorker.
//
//   node scripts/prepare-worker.mjs <app folder> [host...]
//
// Hosts default to this Mac. Needs packages/sdk built and installed, with the
// platform packages of each host.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [appArg, ...hostArgs] = process.argv.slice(2)
if (appArg === undefined) {
  console.error('Usage: node scripts/prepare-worker.mjs <app folder> [host...]')
  process.exit(1)
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdkRoot = path.resolve(packageRoot, '..', 'sdk')
const appRoot = path.resolve(packageRoot, appArg)
const outputDir = path.join(appRoot, 'QvacWorker')
const hosts = hostArgs.length > 0 ? hostArgs : [`darwin-${process.arch}`]

const { bundleSdk } = await import(
  pathToFileURL(path.join(sdkRoot, 'dist', 'src', 'commands', 'index.js')).href
)

await rm(outputDir, { recursive: true, force: true })

const bundle = await bundleSdk({
  projectRoot: sdkRoot,
  sdkPath: sdkRoot,
  configPath: path.join(appRoot, 'qvac.config.json'),
  target: 'bare-kit',
  language: 'swift',
  outputDir,
  hosts,
  quiet: true
})

console.log(`Bundled the worker for ${hosts.join(', ')} with ${bundle.addons.length} native addons into ${outputDir}`)
