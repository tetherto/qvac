import { collectCheckSections, isReportOk } from './checks/index.js'
import { formatJsonReport, formatReport } from './format.js'
import type { DoctorReport, RunDoctorOptions } from './types.js'

export async function runDoctor (
  options: RunDoctorOptions = {}
): Promise<DoctorReport> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const sections = collectCheckSections({ projectRoot })

  const report: DoctorReport = {
    ok: isReportOk(sections),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    sections
  }

  if (options.json) {
    process.stdout.write(`${formatJsonReport(report)}\n`)
  } else if (!options.quiet) {
    process.stdout.write(`${formatReport(report)}\n`)
  }

  return report
}

export type { DoctorReport, RunDoctorOptions } from './types.js'
