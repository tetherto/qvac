#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { bundleSdk } from './bundle-sdk/index.js'
import { handleError } from './errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

function setupCli(): void {
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
    .action(
      async (options: {
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
      }
    )

  program
    .command('doctor')
    .description('Validate that the host satisfies QVAC SDK system requirements')
    .option('--json', 'Output the report as JSON')
    .option('-q, --quiet', 'Suppress human-readable output (only set exit code)')
    .option('-v, --verbose', 'Detailed output')
    .action(async (options: { json?: boolean; quiet?: boolean; verbose?: boolean }) => {
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

  const verifyCmd = program
    .command('verify')
    .description('Verify QVAC artifacts and dependency changes')

  verifyCmd
    .command('deps')
    .description('Detect native addon changes between two npm lockfile refs')
    .requiredOption('--base <ref>', 'Base git ref or SHA')
    .requiredOption('--head <ref>', 'Head git ref or SHA')
    .option('--lockfile <path>', 'Path to npm package-lock.json', 'package-lock.json')
    .option('-q, --quiet', 'Suppress output when there are no native changes')
    .exitOverride((err) => {
      process.exit(err.exitCode === 0 ? 0 : 2)
    })
    .action(async (options: { base: string; head: string; lockfile: string; quiet?: boolean }) => {
      try {
        const { formatVerifyDepsResult, hasNativeChanges, verifyDeps } =
          await import('./verify/deps/index.js')
        const result = await verifyDeps({
          projectRoot: process.cwd(),
          base: options.base,
          head: options.head,
          lockfilePath: options.lockfile
        })

        const changed = hasNativeChanges(result)
        if (!options.quiet || changed) {
          console.log(formatVerifyDepsResult(result))
        }
        if (changed) process.exit(1)
      } catch (error: unknown) {
        handleError(error)
        process.exit(2)
      }
    })

  verifyCmd
    .command('bundle')
    .description('Verify native addon prebuilds and ABI for a bundle or node_modules tree')
    .requiredOption(
      '--addons-source <path>',
      'Path to a worker.bundle.js or a node_modules directory'
    )
    .option('--host <target>', 'Target host (repeatable, at least one required)', collect, [])
    .option(
      '--bare-runtime-version <semver>',
      'Override detected Bare runtime version for ABI checks'
    )
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option(
      '--project-root <path>',
      'Project root used to resolve bundle resolutions and runtime metadata (default: cwd)'
    )
    .option('--json', 'Output the verification result as JSON')
    .option('-q, --quiet', 'Suppress success output')
    .action(
      async (options: {
        addonsSource: string
        host: string[]
        bareRuntimeVersion?: string
        config?: string
        projectRoot?: string
        json?: boolean
        quiet?: boolean
      }) => {
        try {
          // verifyBundle in @qvac/sdk/commands already emits an `invalid-source`
          // issue with message "At least one host is required." when hosts is
          // empty — no need to duplicate the guard here.
          const { formatVerifyBundleResult, hasErrors, verifyBundle } =
            await import('./verify/bundle/index.js')
          const verifyOptions: Parameters<typeof verifyBundle>[0] = {
            projectRoot: options.projectRoot ?? process.cwd(),
            addonsSource: options.addonsSource,
            hosts: options.host
          }
          if (options.bareRuntimeVersion) {
            verifyOptions.bareRuntimeVersion = options.bareRuntimeVersion
          }
          if (options.config) {
            verifyOptions.configPath = options.config
          }
          const result = await verifyBundle(verifyOptions)
          const failed = hasErrors(result)
          if (options.json) {
            console.log(JSON.stringify(result, null, 2))
          } else if (!options.quiet || failed || result.issues.length > 0) {
            console.log(formatVerifyBundleResult(result))
          }
          if (failed) process.exit(1)
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )

  const openaiCmd = program.command('openai').description('OpenAI adapter introspection')

  openaiCmd
    .command('coverage')
    .description('Show OpenAI endpoint coverage for qvac serve openai')
    .option('--json', 'Output JSON report')
    .option('--unsupported', 'List only unsupported endpoints')
    .option('--unknown', 'List only uncategorized (unknown) endpoints')
    .option(
      '--primary-ai',
      'Restrict to spec-derived primary AI inference surface (Chat, Audio, Images, …)'
    )
    .option('--consumer-primary', 'Restrict to consumer-demanded primary AI surface')
    .option('--offline', 'Use cached OpenAPI spec (~/.cache/qvac/openai-spec.yaml)')
    .action(
      async (options: {
        json?: boolean
        unsupported?: boolean
        unknown?: boolean
        primaryAi?: boolean
        consumerPrimary?: boolean
        offline?: boolean
      }) => {
        try {
          const { runOpenAiCoverage } = await import('./openai/coverage.js')
          const covOpts: Parameters<typeof runOpenAiCoverage>[0] = {}
          if (options.json) covOpts.json = true
          if (options.unsupported) covOpts.unsupported = true
          if (options.unknown) covOpts.unknown = true
          if (options.primaryAi) covOpts.primaryAi = true
          if (options.consumerPrimary) covOpts.consumerPrimary = true
          if (options.offline) covOpts.offline = true
          await runOpenAiCoverage(covOpts)
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )

  openaiCmd
    .command('spec')
    .description('Emit the OpenAPI spec for qvac serve openai (without starting the server)')
    .option('-o, --output <path>', 'Write to file instead of stdout')
    .option('--yaml', 'Emit YAML instead of JSON')
    .action(async (options: { output?: string; yaml?: boolean }) => {
      try {
        const { emitOpenApiSpec } = await import('./openai/spec.js')
        const specOpts: Parameters<typeof emitOpenApiSpec>[0] = {}
        if (options.output) specOpts.output = options.output
        if (options.yaml) specOpts.format = 'yaml'
        await emitOpenApiSpec(specOpts)
      } catch (error: unknown) {
        handleError(error)
        process.exit(1)
      }
    })

  const serveCmd = program.command('serve').description('Start an API server backed by QVAC')

  serveCmd
    .command('openai')
    .description('Start an OpenAI-compatible REST API server')
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('-p, --port <number>', 'Port to listen on', '11434')
    .option('-H, --host <address>', 'Host to bind to', '127.0.0.1')
    .option(
      '--model <alias>',
      'Model alias to preload (repeatable, must be in config)',
      collect,
      []
    )
    .option('--api-key <key>', 'Require Bearer token authentication')
    .option('--cors', 'Enable CORS headers')
    .option(
      '--public-base-url <url>',
      'Externally reachable origin (required for image response_format=url)'
    )
    .option('--docs', 'Expose Swagger UI at /docs (JSON spec is always at /openapi.json)')
    .option('-v, --verbose', 'Detailed output')
    .action(
      async (options: {
        config?: string
        port: string
        host: string
        model: string[]
        apiKey?: string
        cors?: boolean
        publicBaseUrl?: string
        docs?: boolean
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
            publicBaseUrl: options.publicBaseUrl,
            docs: options.docs,
            verbose: options.verbose
          })
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )

  program.parse()
}

setupCli()
