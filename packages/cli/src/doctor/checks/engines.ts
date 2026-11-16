import fs from 'node:fs'
import path from 'node:path'
import type { CheckResult } from '@/doctor/types'

const LABEL = 'Bare engine requirements (engines.bare)'

/** One representative per platform: every host of a platform runs the same Bare build. */
const MOBILE_HOSTS = ['android-arm64', 'ios-arm64']

export interface CheckBareEnginesOptions {
  network?: boolean | undefined
  onProgress?: ((message: string) => void) | undefined
  /** Test seam: the bare-stow whose Bare Kit pins are read, instead of the SDK's. */
  bareStowDir?: string | undefined
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
 * Compares every package's engines.bare with the Bare the worker runs on: in
 * a phone project, the Bare that Bare Kit runs on Android and iOS, as pinned
 * by the project's bare-stow; otherwise the Bare of the project's bare-sidecar
 * on this machine, or of pear-runtime's for a bundle written for pear-runtime.
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

  const phone = commands.isReactNativeBareKitInstalled(projectRoot)
  const hosts = phone ? MOBILE_HOSTS : [`${process.platform}-${process.arch}`]
  const bundlePath = path.join(
    projectRoot,
    'qvac',
    'worker',
    phone ? 'index.bundle.mjs' : 'index.bundle'
  )
  const addonsSource = fs.existsSync(bundlePath) ? bundlePath : nodeModules

  const result = await commands.verifyBundle({
    projectRoot,
    addonsSource,
    hosts,
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    ...(options.bareStowDir !== undefined ? { bareStowDir: options.bareStowDir } : {})
  })

  const hostList = hosts.join(', ')
  const runtimes = result.runtimes.map(({ hosts, resolution }) =>
    resolution.resolved
      ? `${hosts.join(', ')}: Bare ${resolution.runtime.version} (${commands.formatRuntimeSource(resolution.runtime)})`
      : `${hosts.join(', ')}: unknown (${resolution.error.reason})`
  )
  const source = `Checked ${path.relative(projectRoot, addonsSource) || addonsSource}`
  const detail = [source, ...runtimes].join('\n')
  const addons = result.issues.filter((issue) => issue.code === 'abi-mismatch')
  const packages = result.issues.filter((issue) => issue.code === 'engines-mismatch')

  if (addons.length > 0 || packages.length > 0) {
    const hint = [
      ...(addons.length > 0
        ? [
            'These addons are built for a newer Bare than the worker runs, so they fail to load there:',
            ...addons.map((issue) => `  - ${issue.message}`),
            ''
          ]
        : []),
      ...(packages.length > 0
        ? [
            'These packages declare a newer Bare than the worker runs:',
            ...packages.map((issue) => `  - ${issue.message}`),
            ''
          ]
        : [])
    ]
    for (const advice of result.advice) hint.push(...commands.formatEnginesAdvice(advice))
    const count = addons.length > 0 ? addons.length : packages.length
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: addons.length > 0 ? 'fail' : 'warn',
      severity: addons.length > 0 ? 'required' : 'recommended',
      code: addons.length > 0 ? 'abi-mismatch' : 'engines-mismatch',
      value: `${count} ${addons.length > 0 ? 'addon' : 'package'}${count === 1 ? '' : 's'} need a newer Bare`,
      hint: indent(hint),
      detail
    }
  }

  const unknown = result.runtimes.flatMap(({ hosts, resolution }) =>
    resolution.resolved
      ? []
      : [`engines.bare not checked for ${hosts.join(', ')}: ${resolution.error.reason}`]
  )
  if (unknown.length > 0) {
    return {
      id: 'project-bare-engines',
      label: LABEL,
      status: 'warn',
      severity: 'recommended',
      value: 'runtime version unknown, not checked',
      hint: indent(unknown),
      detail
    }
  }

  return {
    id: 'project-bare-engines',
    label: LABEL,
    status: 'pass',
    severity: 'recommended',
    value: runtimes.length > 0 ? runtimes.join('; ') : hostList,
    detail: source
  }
}
