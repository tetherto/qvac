#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { bundleSdk } from './bundle-sdk/index.js'
import { handleError } from './errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

function collect (value: string, previous: string[]): string[] {
  return previous.concat([value])
}

function setupCli (): void {
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
    .action(async (options: {
      config?: string
      sdkPath?: string
      host: string[]
      defer: string[]
      quiet?: boolean
      verbose?: boolean
    }) => {
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
      } catch (error: unknown) {
        handleError(error)
        process.exit(1)
      }
    })

  program.parse()
}

setupCli()
