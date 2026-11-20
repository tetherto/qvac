import type { Command } from 'commander'
import { collect } from '@/cli/options'
import { handleError } from '@/errors'
import { fitRejectionHint } from '@/fit/format'

export function registerFitCommand(program: Command): void {
  program
    .command('fit')
    .description('Check whether models fit this machine before downloading them')
    .argument('[models...]', 'SDK model constant names or serve.models aliases, loaded together')
    .option('-c, --config <path>', 'Config file with serve.models aliases (default: auto-detect)')
    .option(
      '--set <[target:]key=value>',
      'Config for one model or model type, or for every model without a target; dotted keys nest, values parse as JSON (repeatable)',
      collect,
      []
    )
    .option('--catalog', 'Judge every SDK model on its own, and list the ones with no verdict')
    .option('--json', 'Output the answer as JSON')
    .addHelpText(
      'after',
      `
Exit status: 0 fits, 2 does not fit, 3 unknown, 1 error. --catalog exits 0 once every model is judged.

Examples:
  qvac fit QWEN3_8B_INST_Q4_K_M --set ctxSize=8192
  qvac fit QWEN3_8B_INST_Q4_K_M QWEN3_600M_INST_Q4 --set QWEN3_8B_INST_Q4_K_M:ctxSize=0
  qvac fit --catalog --set llamacpp-completion:ctxSize=0 --json`
    )
    .action(
      async (
        models: string[],
        options: { config?: string; set: string[]; catalog?: boolean; json?: boolean }
      ) => {
        try {
          const { runFit } = await import('@/fit/index')
          process.exitCode = await runFit({
            projectRoot: process.cwd(),
            config: options.config,
            models,
            set: options.set,
            catalog: options.catalog,
            json: options.json
          })
        } catch (error: unknown) {
          handleError(error)
          const hint = fitRejectionHint(error)
          if (hint !== undefined) console.error(`${hint}\n`)
          process.exit(1)
        }
      }
    )
}
