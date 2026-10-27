import { handleError } from '@/lib/errors'

export const handler0 = async (options: {
  config?: string
  yes?: boolean
  modality: string[]
  force?: boolean
  quiet?: boolean
}) => {
  try {
    const { runConfigure } = await import('@/lib/configure/index')
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
