#!/usr/bin/env bare
import type { LaunchOptions } from './lib/types.js'
import { launch } from './cli/launch.js'
import { packageVersion } from './cli/version.js'
import process from 'bare-process'
import os from 'bare-os'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import { find, parseArgs } from './cli/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Bare launches and runs the app in this same process, so no Node is needed past install.
await launch(process.argv.slice(2), {
  tree: { parseArgs, find },
  name: 'duck',
  root,
  version: packageVersion(root),
  dataDir: path.join(os.homedir(), '.qvac', 'duck'),
  launcher: { runtime: process.execPath, script: fileURLToPath(import.meta.url) },
  node: 'node',
  async runApp(options: LaunchOptions, env) {
    Object.assign(process.env, env)
    const { main } = await import('./product/main.js')
    await main(options)
  }
})
