import type { Command } from 'commander'
import { handleError } from '@/errors'

export function registerOpenAiCommand(program: Command): void {
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
          const { runOpenAiCoverage } = await import('@/openai/coverage')
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
        const { emitOpenApiSpec } = await import('@/openai/spec')
        const specOpts: Parameters<typeof emitOpenApiSpec>[0] = {}
        if (options.output) specOpts.output = options.output
        if (options.yaml) specOpts.format = 'yaml'
        await emitOpenApiSpec(specOpts)
      } catch (error: unknown) {
        handleError(error)
        process.exit(1)
      }
    })
}
