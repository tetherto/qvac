import { collectCheckSections, isReportOk } from './checks/index.js'
import { collectDeepCheckSection } from './deep.js'
import { formatJsonReport, formatReport } from './format.js'
import type { DoctorReport, RunDoctorOptions } from './types.js'

// lunte-disable-next-line require-await
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const sections = collectCheckSections({ projectRoot })
  if (options.deep) sections.push(await collectDeepCheckSection(projectRoot))

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
    process.stdout.write(`${formatReport(report, { verbose: options.verbose })}\n`)
  }

  return report
}

export type { DoctorReport, RunDoctorOptions } from './types.js'
