import { handleError } from '@/lib/errors'

export const handler0 = async (options: {
  deep?: boolean
  json?: boolean
  quiet?: boolean
  verbose?: boolean
  offline?: boolean
}) => {
  try {
    const { runDoctor } = await import('@/lib/doctor/index')
    const report = await runDoctor({
      projectRoot: process.cwd(),
      deep: options.deep,
      json: options.json,
      quiet: options.quiet,
      verbose: options.verbose,
      offline: options.offline
    })
    if (!report.ok) process.exit(1)
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
