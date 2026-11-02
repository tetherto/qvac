import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import semver from 'semver'

export type PackageManagerName = 'npm' | 'pnpm' | 'bun' | 'yarn'

const PACKAGE_MANAGERS: readonly PackageManagerName[] = ['npm', 'pnpm', 'bun', 'yarn']

const LOCKFILES: readonly (readonly [string, PackageManagerName])[] = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn']
]

/**
 * Files a package manager writes into the node_modules it installs. They name
 * the tool that built the tree even where the project keeps no lockfile. Bun's
 * default layout writes none.
 */
const INSTALL_MARKERS: readonly (readonly [string, PackageManagerName])[] = [
  ['.package-lock.json', 'npm'],
  ['.modules.yaml', 'pnpm'],
  ['.yarn-state.yml', 'yarn'],
  ['.yarn-integrity', 'yarn']
]

interface InstallEvidence {
  declared: string | null
  found: { manager: PackageManagerName; source: string }[]
}

/**
 * The package manager that owns `projectRoot`, from the project's own
 * `packageManager` field, lockfile, or node_modules install files. A project
 * with none of those is a workspace member only if the nearest directory above
 * it that has them is a workspace root listing it; any other enclosing project
 * belongs to someone else, and its package manager is not this one's.
 */
export async function detectPackageManager(projectRoot: string) {
  const start = path.resolve(projectRoot)
  const own = await readInstallEvidence(start)
  if (hasEvidence(own)) return decidePackageManager(start, own)

  let dir = start
  for (;;) {
    const parent = path.dirname(dir)
    if (parent === dir) {
      return {
        manager: null,
        reason: `no lockfile or packageManager field found in ${start} or its parent directories`
      }
    }
    dir = parent

    const evidence = await readInstallEvidence(dir)
    if (!hasEvidence(evidence)) continue
    if (!(await isWorkspaceMember(dir, start))) {
      return {
        manager: null,
        reason:
          `${start} has no lockfile of its own, and ${dir}, which has one, ` +
          'is not a workspace root that lists it'
      }
    }
    return decidePackageManager(dir, evidence)
  }
}

export function isPackageManagerName(value: string): value is PackageManagerName {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}

function hasEvidence(evidence: InstallEvidence) {
  return evidence.declared !== null || evidence.found.length > 0
}

/** A declared `packageManager` decides; otherwise every lockfile and install file must agree. */
function decidePackageManager(dir: string, evidence: InstallEvidence) {
  const { declared, found } = evidence
  if (declared !== null) {
    const name = declared.split('@')[0] ?? ''
    if (!isPackageManagerName(name)) {
      return {
        manager: null,
        reason:
          `package.json in ${dir} declares packageManager "${declared}", ` +
          'which is not npm, pnpm, bun, or Yarn'
      }
    }
    return {
      manager: name,
      source: `packageManager "${declared}" in ${path.join(dir, 'package.json')}`
    }
  }

  const managers = [...new Set(found.map((entry) => entry.manager))]
  const [first] = found
  if (managers.length === 1 && first !== undefined) {
    return { manager: first.manager, source: first.source }
  }
  return {
    manager: null,
    reason:
      `${dir} has install files from ${managers.join(', ')} ` +
      `(${found.map((entry) => path.relative(dir, entry.source)).join(', ')}); ` +
      'set the packageManager field in package.json to pick one'
  }
}

async function readInstallEvidence(dir: string): Promise<InstallEvidence> {
  const found: InstallEvidence['found'] = []
  for (const [file, manager] of LOCKFILES) {
    const source = path.join(dir, file)
    if (await isFile(source)) found.push({ manager, source })
  }
  for (const [file, manager] of INSTALL_MARKERS) {
    const source = path.join(dir, 'node_modules', file)
    if (await isFile(source)) found.push({ manager, source })
  }
  const manifest = await readPackageJson(dir)
  const field = manifest?.['packageManager']
  return { declared: typeof field === 'string' && field.length > 0 ? field : null, found }
}

async function isFile(filePath: string) {
  try {
    return (await fsp.stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function readPackageJson(dir: string) {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Whether the workspace globs declared at `rootDir` (package.json `workspaces`
 * for npm, Yarn, and bun; `pnpm-workspace.yaml` for pnpm) include `memberDir`.
 */
export async function isWorkspaceMember(rootDir: string, memberDir: string) {
  const relative = path.relative(rootDir, memberDir).split(path.sep).join('/')
  let included = false
  for (const pattern of await readWorkspacePatterns(rootDir)) {
    const negated = pattern.startsWith('!')
    const glob = (negated ? pattern.slice(1) : pattern).replace(/^\.\//, '').replace(/\/+$/, '')
    if (globToRegExp(glob).test(relative)) included = !negated
  }
  return included
}

async function readWorkspacePatterns(dir: string) {
  const patterns: string[] = []

  const workspaces = (await readPackageJson(dir))?.['workspaces']
  const list =
    typeof workspaces === 'object' && workspaces !== null && !Array.isArray(workspaces)
      ? (workspaces as { packages?: unknown }).packages
      : workspaces
  if (Array.isArray(list)) {
    patterns.push(...list.filter((entry): entry is string => typeof entry === 'string'))
  }

  try {
    const yaml = await fsp.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
    patterns.push(...parsePnpmWorkspacePackages(yaml))
  } catch {
    // Not a pnpm workspace.
  }
  return patterns
}

/**
 * The `packages` list of a pnpm-workspace.yaml, in block (`- 'apps/*'`) or
 * flow (`packages: ['apps/*']`) form. The SDK has no YAML parser, and the
 * file's other keys are irrelevant here.
 */
export function parsePnpmWorkspacePackages(yaml: string) {
  const patterns: string[] = []
  let inPackages = false
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    const flow = /^packages\s*:\s*\[(.*)\]\s*$/.exec(line)
    if (flow !== null) {
      patterns.push(...(flow[1] ?? '').split(',').map(unquote).filter(Boolean))
      break
    }
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^\S/.test(line)) break
    const item = /^\s*-\s*(.+?)\s*$/.exec(line)
    if (item !== null) patterns.push(unquote(item[1] ?? ''))
  }
  return patterns
}

function unquote(value: string) {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2')
}

/** `*` matches within one path segment, `**` across segments. */
function globToRegExp(glob: string) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? ''
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Why `manager` cannot install in `cwd`, or null when it can. The supported
 * set matches the installers the split addons document: npm 7+, pnpm, bun,
 * and Yarn Berry.
 */
export async function checkPackageManagerSupport(manager: PackageManagerName, cwd: string) {
  const result = await runPackageManager(manager, ['--version'], { cwd, quiet: true })
  if (result.error !== undefined || result.code !== 0) {
    return `\`${manager} --version\` failed; is ${manager} installed and on PATH?`
  }

  const version = semver.coerce(result.stdout.trim())?.version
  if (version === undefined) return null
  if (manager === 'npm' && semver.lt(version, '7.0.0')) {
    return `npm ${version} is too old; npm 7 or later is required`
  }
  if (manager === 'yarn' && semver.lt(version, '2.0.0')) {
    return `Yarn ${version} (Yarn Classic) is not supported; use Yarn Berry (2 or later)`
  }
  return null
}

/** Arguments that add `specs` as exact-version dependencies of the package in cwd. */
export function installArgs(manager: PackageManagerName, specs: string[]) {
  switch (manager) {
    case 'npm':
      return ['install', '--save-exact', ...specs]
    case 'pnpm':
      return ['add', '--save-exact', ...specs]
    case 'bun':
    case 'yarn':
      return ['add', '--exact', ...specs]
  }
}

export interface RunPackageManagerResult {
  code: number | null
  stdout: string
  stderr: string
  error?: Error
}

/**
 * Quiet runs capture stdout and stderr; other runs stream them to this
 * process. Windows resolves the package managers' `.cmd` shims through the
 * shell, which does not escape arguments, so callers must pass only
 * validated ones.
 */
export function runPackageManager(
  manager: PackageManagerName,
  args: string[],
  options: { cwd: string; quiet: boolean }
) {
  return new Promise<RunPackageManagerResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    }
    const proc: ChildProcess =
      process.platform === 'win32'
        ? spawn([manager, ...args].join(' '), { ...spawnOptions, shell: true })
        : spawn(manager, args, spawnOptions)
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    proc.on('error', (error) => resolve({ code: null, stdout, stderr, error }))
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
