import { handleError } from '@/lib/errors'

export const handler0 = async (options: {
  json?: boolean
  unsupported?: boolean
  unknown?: boolean
  primaryAi?: boolean
  consumerPrimary?: boolean
  offline?: boolean
}) => {
  try {
    const { runOpenAiCoverage } = await import('@/lib/openai/coverage')
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

export const handler1 = async (options: { output?: string; yaml?: boolean }) => {
  try {
    const { emitOpenApiSpec } = await import('@/lib/openai/spec')
    const specOpts: Parameters<typeof emitOpenApiSpec>[0] = {}
    if (options.output) specOpts.output = options.output
    if (options.yaml) specOpts.format = 'yaml'
    await emitOpenApiSpec(specOpts)
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
