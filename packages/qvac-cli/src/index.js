#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { bundleSdk } from './bundle-sdk/index.js'
import { handleError } from './errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

function collect (value, previous) {
  return previous.concat([value])
}

function setupCli () {
  const program = new Command()

  program
    .name('qvac')
    .description('Command-line interface for the QVAC ecosystem')
    .version(pkg.version)

  const bundleCmd = program
    .command('bundle')
    .description('Bundle QVAC artifacts for different runtimes')

  bundleCmd
    .command('sdk')
    .description('Generate a tree-shaken Bare worker bundle with selected plugins')
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('--sdk-path <path>', 'Path to SDK package (default: auto-detect in node_modules)')
    .option('--host <target>', 'Target host (repeatable)', collect, [])
    .option('--defer <module>', 'Defer a module (repeatable)', collect, [])
    .option('-q, --quiet', 'Minimal output')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options) => {
      try {
        await bundleSdk({
          projectRoot: process.cwd(),
          configPath: options.config,
          sdkPath: options.sdkPath,
          hosts: options.host.length > 0 ? options.host : undefined,
          defer: options.defer.length > 0 ? options.defer : undefined,
          quiet: options.quiet,
          verbose: options.verbose
        })
      } catch (error) {
        handleError(error)
        process.exit(1)
      }
    })

  program.parse()
}

setupCli()
