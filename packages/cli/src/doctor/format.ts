import type { CheckResult, CheckStatus, DoctorReport } from '@/doctor/types'

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: '✅',
  warn: '⚠️ ',
  fail: '❌',
  skip: '•',
  info: 'ℹ️ '
}

function formatCheckLine(check: CheckResult): string {
  const icon = STATUS_ICON[check.status]
  const value = check.value ? ` — ${check.value}` : ''
  return `  ${icon} ${check.label}${value}`
}

export function formatReport(
  report: DoctorReport,
  options: { verbose?: boolean | undefined } = {}
): string {
  const lines: string[] = []
  lines.push('🩺 QVAC doctor')
  lines.push('')
  lines.push(`  Host: ${report.platform}-${report.arch}, Node ${report.nodeVersion}`)
  lines.push('')

  for (const section of report.sections) {
    lines.push(`${section.title}:`)
    for (const check of section.checks) {
      lines.push(formatCheckLine(check))
      if (check.status !== 'pass' && check.hint) {
        lines.push(`      ${check.hint}`)
      }
      if (options.verbose && check.detail) {
        for (const line of check.detail.split('\n')) lines.push(`      ${line}`)
      }
    }
    lines.push('')
  }

  if (report.ok) {
    lines.push('✅ All required checks passed.')
  } else {
    lines.push('❌ One or more required checks failed. See hints above.')
  }

  return lines.join('\n')
}

export function formatJsonReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}
