import type { Command } from 'commander'
import { collect } from '@/cli/options'
import { handleError } from '@/errors'

export function registerVerifyCommand(program: Command): void {
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
          await import('@/verify/deps/index')
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
            await import('@/verify/bundle/index')
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
}
