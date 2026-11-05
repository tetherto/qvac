import { resolve } from 'node:path'

import { runAudit } from './audit.js'

async function main(): Promise<void> {
  const argument = process.argv[2] ?? 'audit'
  if (argument !== 'audit' && argument !== 'baseline') {
    throw new Error(`Unknown quality command: ${argument}`)
  }

  const run = await runAudit({
    root: resolve(process.cwd()),
    command: argument,
  })
  const newCount = run.result.findings.filter(({ status }) => status === 'new').length
  const existingCount = run.result.findings.length - newCount
  const resolutionSummary = run.result.resolutionStatus === 'complete'
    ? `${run.result.resolved.length} resolved`
    : 'resolutions withheld'

  process.stdout.write(
    `Code quality: ${newCount} new, ${existingCount} existing, ${run.result.changes.length} changed, ${resolutionSummary}, ${run.result.diagnostics.length} analysis errors.\n`,
  )
  process.stdout.write(`Report: ${run.markdownPath}\n`)
  if (argument === 'baseline' && run.exitCode === 0) {
    process.stdout.write(`Baseline: ${run.baselinePath}\n`)
  }
  process.exitCode = run.exitCode
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Code-quality audit failed: ${message}\n`)
  process.exitCode = 1
})
