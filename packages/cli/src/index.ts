#!/usr/bin/env node
import type { LaunchOptions } from '@qvac/cli-kit/launch'
import { launch, packageVersion, supervise } from '@qvac/cli-kit/launch'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { find, parseArgs } from './cli/index.js'
import { sdkArguments } from './cli/commands/sdk/arguments.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const entry = fileURLToPath(new URL('./product/entry.js', import.meta.url))

// Keep the SDK server in this process: readiness FDs and signal/PID semantics are public.
const sdkWords = sdkArguments(process.argv.slice(2))
if (sdkWords) {
  const { runSdkCommand } = await import('./cli/sdk-entry.js')
  await runSdkCommand(sdkWords)
} else {
  // Node launches, and the app runs in a Bare child it supervises.
  await launch(process.argv.slice(2), {
    tree: { parseArgs, find },
    name: 'qvac',
    root,
    version: packageVersion(root),
    dataDir: path.join(os.homedir(), '.qvac', 'cli'),
    launcher: { runtime: process.execPath, script: fileURLToPath(import.meta.url) },
    runApp(options: LaunchOptions, env) {
      const bare = require('bare-runtime')()
      // Some development dependency restores lose the executable bit; a read-only install keeps it.
      if (process.platform !== 'win32') {
        try {
          fs.accessSync(bare, fs.constants.X_OK)
        } catch {
          fs.chmodSync(bare, 0o755)
        }
      }

      supervise(spawn(bare, [entry, JSON.stringify(options)], { stdio: 'inherit', env }))
    }
  })
}
