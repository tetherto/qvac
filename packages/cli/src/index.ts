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

  program
    .command('doctor')
    .description('Validate that the host satisfies QVAC SDK system requirements')
    .option('--json', 'Output the report as JSON')
    .option('-q, --quiet', 'Suppress human-readable output (only set exit code)')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options: {
      json?: boolean
      quiet?: boolean
      verbose?: boolean
    }) => {
      try {
        const { runDoctor } = await import('./doctor/index.js')
        const report = await runDoctor({
          projectRoot: process.cwd(),
          json: options.json,
          quiet: options.quiet,
          verbose: options.verbose
        })
        if (!report.ok) process.exit(1)
      } catch (error: unknown) {
        handleError(error)
        process.exit(1)
      }
    })

  const serveCmd = program
    .command('serve')
    .description('Start an API server backed by QVAC')

  serveCmd
    .command('openai')
    .description('Start an OpenAI-compatible REST API server')
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('-p, --port <number>', 'Port to listen on', '11434')
    .option('-H, --host <address>', 'Host to bind to', '127.0.0.1')
    .option('--model <alias>', 'Model alias to preload (repeatable, must be in config)', collect, [])
    .option('--api-key <key>', 'Require Bearer token authentication')
    .option('--cors', 'Enable CORS headers')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options: {
      config?: string
      port: string
      host: string
      model: string[]
      apiKey?: string
      cors?: boolean
      verbose?: boolean
    }) => {
      try {
        const { startServer } = await import('./serve/index.js')
        await startServer({
          projectRoot: process.cwd(),
          config: options.config,
          port: parseInt(options.port, 10),
          host: options.host,
          model: options.model.length > 0 ? options.model : undefined,
          apiKey: options.apiKey,
          cors: options.cors,
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
