import type { Command } from 'commander'
import { handleError } from '@/errors'

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate that the host satisfies QVAC SDK system requirements')
    .option('--deep', 'Start the installed SDK worker and verify its heartbeat')
    .option('--json', 'Output the report as JSON')
    .option('-q, --quiet', 'Suppress human-readable output (only set exit code)')
    .option('-v, --verbose', 'Detailed output')
    .action(
      async (options: { deep?: boolean; json?: boolean; quiet?: boolean; verbose?: boolean }) => {
        try {
          const { runDoctor } = await import('@/doctor/index')
          const report = await runDoctor({
            projectRoot: process.cwd(),
            deep: options.deep,
            json: options.json,
            quiet: options.quiet,
            verbose: options.verbose
          })
          if (!report.ok) process.exit(1)
        } catch (error: unknown) {
          handleError(error)
          process.exit(1)
        }
      }
    )
}
