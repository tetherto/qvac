import type { Command } from 'commander'
import { collect } from '@/cli/options'
import { handleError } from '@/errors'

export function registerBundleCommand(program: Command): void {
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
    .option(
      '--no-install',
      'Do not install missing addon platform packages for mobile hosts into package.json'
    )
    .option('-q, --quiet', 'Minimal output')
    .option('-v, --verbose', 'Detailed output')
    .action(
      async (options: {
        config?: string
        sdkPath?: string
        host: string[]
        defer: string[]
        install: boolean
        quiet?: boolean
        verbose?: boolean
      }) => {
        try {
          const { bundleSdk, HostPrebuildsInstallFailedError, HostPrebuildsInstallRefusedError } =
            await import('@/bundle-sdk/index')
          const bundleOptions = {
            projectRoot: process.cwd(),
            configPath: options.config,
            sdkPath: options.sdkPath,
            hosts: options.host.length > 0 ? options.host : undefined,
            defer: options.defer.length > 0 ? options.defer : undefined,
            quiet: options.quiet,
            verbose: options.verbose
          }

          try {
            const result = await bundleSdk({
              ...bundleOptions,
              installMissingPrebuilds: options.install
            })
            if (result.installedPrebuilds.length > 0 && !options.quiet) {
              console.log('📦 Installed addon platform packages:')
              for (const pkg of result.installedPrebuilds) {
                console.log(`   ${pkg.name}@${pkg.version} (${pkg.hosts.join(', ')})`)
              }
            }
          } catch (error: unknown) {
            if (
              !(error instanceof HostPrebuildsInstallRefusedError) &&
              !(error instanceof HostPrebuildsInstallFailedError)
            ) {
              throw error
            }
            // The install is a convenience: report what to add by hand and
            // still produce the bundle.
            console.warn(`\n⚠️  ${error.message}\n`)
            console.warn(
              '   Bundling without installing them. Pass --no-install to skip this step.\n'
            )
            await bundleSdk(bundleOptions)
          }
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )
}
