export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'info'

export type CheckSeverity = 'required' | 'recommended' | 'informational'

export interface CheckResult {
  id: string
  label: string
  status: CheckStatus
  severity: CheckSeverity
  value?: string
  detail?: string
  hint?: string
}

export interface CheckSection {
  id: 'runtime' | 'hardware' | 'targets' | 'tools' | 'project'
  title: string
  checks: CheckResult[]
}

export interface DoctorReport {
  ok: boolean
  platform: string
  arch: string
  nodeVersion: string
  sections: CheckSection[]
}

export interface RunDoctorOptions {
  projectRoot?: string | undefined
  json?: boolean | undefined
  quiet?: boolean | undefined
  verbose?: boolean | undefined
}
