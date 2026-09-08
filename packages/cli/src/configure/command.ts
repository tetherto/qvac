import type { Command } from 'commander'
import { collect } from '@/cli/options'
import { handleError } from '@/errors'

export function registerConfigureCommand(program: Command): void {
  program
    .command('configure')
    .description('Interactively build a qvac.config.json (serve.models) for local models')
    .option('-c, --config <path>', 'Config file to write (default: ./qvac.config.json)')
    .option('-y, --yes', 'Non-interactive: write a sensible default starter (chat + transcription)')
    .option(
      '--modality <name>',
      'Non-interactive: add a modality (repeatable) — chat|embedding|transcription|speech|image',
      collect,
      []
    )
    .option('--force', 'Re-add a model that is already configured, overwriting its existing entry')
    .option('-q, --quiet', 'Suppress output')
    .action(
      async (options: {
        config?: string
        yes?: boolean
        modality: string[]
        force?: boolean
        quiet?: boolean
      }) => {
        try {
          const { runConfigure } = await import('@/configure/index')
          await runConfigure({
            projectRoot: process.cwd(),
            config: options.config,
            yes: options.yes,
            modality: options.modality.length > 0 ? options.modality : undefined,
            force: options.force,
            quiet: options.quiet
          })
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )
}
