import { collectCheckSections, isReportOk } from '@/doctor/checks/index'
import { collectDeepCheckSection } from '@/doctor/deep'
import { formatJsonReport, formatReport } from '@/doctor/format'
import type { DoctorReport, RunDoctorOptions } from '@/doctor/types'

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

export type { DoctorReport, RunDoctorOptions } from '@/doctor/types'
