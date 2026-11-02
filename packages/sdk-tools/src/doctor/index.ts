import { collectCheckSections, isReportOk } from '@/doctor/checks/index'
import { checkBareEngines } from '@/doctor/checks/engines'
import { collectDeepCheckSection } from '@/doctor/deep'
import { formatJsonReport, formatReport } from '@/doctor/format'
import type { DoctorReport, RunDoctorOptions } from '@/doctor/types'

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const projectRoot = options.projectRoot ?? process.cwd()
  const sections = collectCheckSections({ projectRoot })

  // Progress goes to stderr so `--json` output on stdout stays parseable.
  const onProgress = options.quiet
    ? undefined
    : (message: string) => process.stderr.write(`… ${message}\n`)
  const engines = await checkBareEngines(projectRoot, {
    network: options.offline !== true,
    onProgress
  })
  sections.find((section) => section.id === 'project')?.checks.push(engines)

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
