#!/usr/bin/env bare
import type { LaunchOptions } from './lib/types.js'
import process from 'bare-process'
import { fileURLToPath } from 'bare-url'
import { launch } from './cli/launch.js'
import { find, parseArgs } from './cli/index.js'

// Bare launches and runs the app in this same process, so no Node is needed past install.
await launch(process.argv.slice(2), {
  tree: { parseArgs, find },
  name: 'qvac',
  launcher: { runtime: process.execPath, script: fileURLToPath(import.meta.url) },
  node: 'node',
  async runApp(options: LaunchOptions, env) {
    Object.assign(process.env, env)
    const { main } = await import('./product/main.js')
    await main(options)
  }
})
