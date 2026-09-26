import fs from 'node:fs'
import path from 'node:path'
import type { CheckResult } from '@/doctor/types'

const LABEL = 'Bare engine requirements (engines.bare)'

/** One representative per platform: every host of a platform runs the same Bare build. */
const MOBILE_HOSTS = ['android-arm64', 'ios-arm64']

const ENGINES_ISSUE_CODES = new Set(['abi-mismatch', 'engines-mismatch', 'unknown-runtime-version'])

export interface CheckBareEnginesOptions {
  network?: boolean | undefined
  onProgress?: ((message: string) => void) | undefined
}

function findNodeModules(projectRoot: string) {
  let dir = path.resolve(projectRoot)
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The report prints the first hint line indented; continuation lines need the same indent. */
function indent(lines: string[]) {
  const trimmed = lines.map((line) => line.trimEnd())
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed
    .map((line, index) => (index === 0 || line === '' ? line : `      ${line}`))
    .join('\n')
}

/**
 * Compares every package's engines.bare with the Bare build each target runs:
 * the one inside react-native-bare-kit for mobile, bare-runtime for desktop.
 * Reads the generated worker bundle when there is one, since it names exactly
 * what ships; otherwise scans node_modules, which also includes build tools.
 */
export async function checkBareEngines(
  projectRoot: string,
  options: CheckBareEnginesOptions = {}
): Promise<CheckResult> {
  const nodeModules = findNodeModules(projectRoot)
  if (nodeModules === null) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'skip',
      severity: 'recommended',
      value: 'no node_modules found'
    }
  }

  let commands: typeof import('@qvac/sdk/commands')
  try {
    commands = await import('@qvac/sdk/commands')
  } catch (error) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'skip',
      severity: 'recommended',
      value: 'SDK commands unavailable',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  const mobile = commands.isReactNativeBareKitInstalled(projectRoot)
  const hosts = [...(mobile ? MOBILE_HOSTS : []), `${process.platform}-${process.arch}`]
  const bundlePath = path.join(projectRoot, 'qvac', 'worker.bundle.js')
  const addonsSource = fs.existsSync(bundlePath) ? bundlePath : nodeModules

  const result = await commands.verifyBundle({
    projectRoot,
    addonsSource,
    hosts,
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {})
  })

  const runtimes = (result.runtimes ?? []).map((group) =>
    group.resolution.resolved
      ? `${group.hosts.join(', ')}: Bare ${group.resolution.runtime.version} (${commands.formatRuntimeSource(group.resolution.runtime)})`
      : `${group.hosts.join(', ')}: unknown (${group.resolution.error.reason})`
  )
  const source = `Checked ${path.relative(projectRoot, addonsSource) || addonsSource}`
  const issues = result.issues.filter((issue) => ENGINES_ISSUE_CODES.has(issue.code))
  const errors = issues.filter((issue) => issue.level === 'error')

  if (errors.length > 0) {
    const hint = [
      'These packages require a newer Bare than the app runs on; the app fails to load them:',
      ...errors.map((issue) => `  - ${issue.message}`),
      ''
    ]
    for (const advice of result.advice ?? []) hint.push(...commands.formatEnginesAdvice(advice))
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'fail',
      severity: 'required',
      code: 'engines-mismatch',
      value: `${errors.length} package${errors.length === 1 ? '' : 's'} need a newer Bare`,
      hint: indent(hint),
      detail: [source, ...runtimes].join('\n')
    }
  }

  const warnings = issues.filter((issue) => issue.level === 'warning')
  if (warnings.length > 0) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'warn',
      severity: 'recommended',
      value: 'runtime version unknown',
      hint: indent(warnings.map((issue) => issue.message)),
      detail: [source, ...runtimes].join('\n')
    }
  }

  return {
    id: 'project-bare-engines',
    label: LABEL,
    status: 'pass',
    severity: 'recommended',
    value: runtimes.join('; '),
    detail: source
  }
}
