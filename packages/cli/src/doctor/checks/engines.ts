import fs from 'node:fs'
import path from 'node:path'
import type { CheckResult } from '@/doctor/types'

const LABEL = 'Bare engine requirements (engines.bare)'

/** One representative per platform: every host of a platform runs the same Bare build. */
const MOBILE_HOSTS = ['android-arm64', 'ios-arm64']

const ENGINES_ISSUE_CODES = new Set(['abi-mismatch', 'engines-mismatch'])

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
 * Compares every package's engines.bare with the Bare build inside the app's
 * react-native-bare-kit. Desktop projects run the Bare that bare-sidecar
 * installs with the SDK, so the check applies to phone projects only.
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

  if (!commands.isReactNativeBareKitInstalled(projectRoot)) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'skip',
      severity: 'recommended',
      value: 'not a phone project (no react-native-bare-kit)'
    }
  }

  const bundlePath = path.join(projectRoot, 'qvac', 'worker', 'index.bundle.mjs')
  const addonsSource = fs.existsSync(bundlePath) ? bundlePath : nodeModules

  const result = await commands.verifyBundle({
    projectRoot,
    addonsSource,
    hosts: MOBILE_HOSTS,
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {})
  })

  const hostList = MOBILE_HOSTS.join(', ')
  const runtime =
    result.runtime === null
      ? null
      : result.runtime.resolved
        ? `${hostList}: Bare ${result.runtime.runtime.version} (${commands.formatRuntimeSource(result.runtime.runtime)})`
        : `${hostList}: unknown (${result.runtime.error.reason})`
  const source = `Checked ${path.relative(projectRoot, addonsSource) || addonsSource}`
  const detail = runtime === null ? source : `${source}\n${runtime}`
  const errors = result.issues.filter((issue) => ENGINES_ISSUE_CODES.has(issue.code))

  if (errors.length > 0) {
    const hint = [
      `These packages need a newer Bare than ${hostList} run, so they fail to load there:`,
      ...errors.map((issue) => `  - ${issue.message}`),
      ''
    ]
    if (result.advice !== undefined) hint.push(...commands.formatEnginesAdvice(result.advice))
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'fail',
      severity: 'required',
      code: 'engines-mismatch',
      value: `${errors.length} package${errors.length === 1 ? '' : 's'} need a newer Bare`,
      hint: indent(hint),
      detail
    }
  }

  if (result.runtime !== null && !result.runtime.resolved) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'warn',
      severity: 'recommended',
      value: 'runtime version unknown, not checked',
      hint: indent([`engines.bare not checked for ${hostList}: ${result.runtime.error.reason}`]),
      detail
    }
  }

  return {
    id: 'project-bare-engines',
    label: LABEL,
    status: 'pass',
    severity: 'recommended',
    value: runtime ?? hostList,
    detail: source
  }
}
