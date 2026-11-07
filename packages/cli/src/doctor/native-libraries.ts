import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolvePackageJson } from '@/doctor/checks/project'
import type { CheckResult } from '@/doctor/types'

const exec = promisify(execFile)
const LABEL = 'Linux native prerequisites'
const BARE_SONAME = /@\d+\.bare$/
const MAX_BINARIES = 512
const MAX_PACKAGES = 1_000
const BUDGET_MS = 15_000

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
export type NativePackage = { root: string; manifest: Manifest; dependencies: NativePackage[] }
export interface NativeBinary {
  file: string
  packageRoot: string
  packageName: string
  needed: string[]
  soname?: string | undefined
  searchPaths: string[]
}
export interface NativeFindings {
  required: NativeLibraryFinding[]
  optional: NativeLibraryFinding[]
  packages: NativeLibraryFinding[]
}
export interface NativeLibraryFinding {
  name: string
  requiredBy: { package: string; file: string }[]
}

/** Read dynamic metadata without executing an installed binary (unlike ldd).
 * Keep NEEDED/SONAME parsing aligned with verify-prebuild-symbols.mjs; the CLI
 * cannot import that repository-only CI script from an installed package.
 */
export function parseNativeDynamic(
  output: string
): Pick<NativeBinary, 'needed' | 'soname' | 'searchPaths'> {
  const fields = (tag: string): string[] =>
    [...output.matchAll(new RegExp(`\\(${tag}\\).*?\\[([^\\]]*)\\]`, 'g'))].map(
      (match) => match[1]!
    )
  const runpath = fields('RUNPATH')
  return {
    needed: fields('NEEDED'),
    soname: fields('SONAME')[0],
    searchPaths: (runpath.length > 0 ? runpath : fields('RPATH')).flatMap((value) =>
      value.split(':')
    )
  }
}

export async function readNativeDynamic(
  file: string,
  runCommand: (program: string, args: string[]) => Promise<string>
): Promise<Pick<NativeBinary, 'needed' | 'soname' | 'searchPaths'>> {
  return parseNativeDynamic(await runCommand('readelf', ['-d', '--wide', '--', file]))
}

export async function hostElf(file: string, arch: string): Promise<boolean> {
  if (arch !== 'x64' && arch !== 'arm64') return false
  let handle
  try {
    handle = await fs.open(file, 'r')
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return (
      bytesRead === 20 &&
      header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      header[4] === 2 &&
      header[5] === 1 &&
      header.readUInt16LE(18) === (arch === 'x64' ? 62 : 183)
    )
  } catch {
    return false
  } finally {
    await handle?.close()
  }
}

async function readPackage(root: string): Promise<NativePackage> {
  return {
    root: await fs.realpath(root),
    manifest: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Manifest,
    dependencies: []
  }
}

async function resolveDependency(pkg: NativePackage, name: string): Promise<NativePackage | null> {
  const manifest = resolvePackageJson(pkg.root, name)
  return manifest === null ? null : readPackage(path.dirname(manifest))
}

async function collectPackages(
  projectRoot: string,
  checkBudget: () => void
): Promise<NativePackage[]> {
  const manifest = resolvePackageJson(projectRoot)
  if (manifest === null) throw new Error('SDK package root not found')
  const first = await readPackage(path.dirname(manifest))
  const packages = new Map([[first.root, first]])
  const queue = [first]
  for (const pkg of queue) {
    checkBudget()
    for (const name of new Set([
      ...Object.keys(pkg.manifest.dependencies ?? {}),
      ...Object.keys(pkg.manifest.optionalDependencies ?? {})
    ])) {
      const dep = await resolveDependency(pkg, name)
      if (dep === null) continue
      if (!packages.has(dep.root)) {
        if (packages.size >= MAX_PACKAGES) throw new Error('Package scan limit reached')
        packages.set(dep.root, dep)
        queue.push(dep)
      }
      pkg.dependencies.push(packages.get(dep.root)!)
    }
  }
  return queue
}

async function collectBinaries(
  packages: NativePackage[],
  arch: string,
  inspect: (file: string) => Promise<Pick<NativeBinary, 'needed' | 'soname' | 'searchPaths'>>,
  checkBudget: () => void
): Promise<NativeBinary[]> {
  const binaries: NativeBinary[] = []
  const seen = new Set<string>()
  async function visit(dir: string, pkg: NativePackage): Promise<void> {
    checkBudget()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      checkBudget()
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file, pkg)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const real = await fs.realpath(file)
        if (seen.has(real) || !(await hostElf(real, arch))) continue
        seen.add(real)
        if (binaries.length >= MAX_BINARIES) throw new Error('Native binary scan limit reached')
        binaries.push({
          file,
          packageRoot: pkg.root,
          packageName: pkg.manifest.name,
          ...(await inspect(file))
        })
      }
    }
  }
  for (const pkg of packages) {
    await visit(path.join(pkg.root, 'prebuilds', `linux-${arch}`), pkg)
    // Published platform packages can wrap the original addon package.
    await visit(path.join(pkg.root, 'addon', 'prebuilds', `linux-${arch}`), pkg)
  }
  return binaries
}

// Bare's ABI-versioned dependencies are resolved by SONAME, not package name
// or binding.js source. An unrelated installed provider cannot satisfy them.
export function packageProvides(
  binary: NativeBinary,
  soname: string,
  binaries: NativeBinary[],
  packages: NativePackage[]
): boolean {
  const consumer = packages.find((pkg) => pkg.root === binary.packageRoot)
  if (consumer === undefined) return false
  const providers = new Set<string>()
  const queue = [consumer]
  for (const pkg of queue) {
    if (providers.has(pkg.root)) continue
    providers.add(pkg.root)
    queue.push(...pkg.dependencies)
  }
  return binaries.some(
    (candidate) => candidate.soname === soname && providers.has(candidate.packageRoot)
  )
}

export async function resolvesFrom(
  binary: NativeBinary,
  name: string,
  inputs: {
    dirs: string[]
    cache: Map<string, string[]>
    projectRoot: string
    exists: (file: string) => Promise<boolean>
    libraryPath?: string | undefined
  }
): Promise<boolean> {
  const origin = path.dirname(binary.file)
  const expand = (value: string): string => value.replace(/\$\{ORIGIN\}|\$ORIGIN\b/g, origin)
  // $ORIGIN in LD_LIBRARY_PATH is relative to the executable, not this addon.
  // Do not guess other dynamic-loader tokens either.
  const searchPaths = binary.searchPaths.map(expand)
  if ((inputs.libraryPath ?? '').includes('$') || searchPaths.some((dir) => dir.includes('$'))) {
    throw new Error('Unsupported dynamic-loader path token; static resolution is incomplete')
  }
  const dirs = [...(inputs.libraryPath?.split(':') ?? []), ...searchPaths, ...inputs.dirs]
  const candidates = name.includes('/')
    ? [path.resolve(inputs.projectRoot, expand(name))]
    : [
        ...dirs.map((dir) => path.resolve(inputs.projectRoot, dir, name)),
        ...(inputs.cache.get(name) ?? [])
      ]
  for (const file of candidates) if (await inputs.exists(file)) return true
  return false
}

function isOptionalBackend(binary: NativeBinary, binaries: NativeBinary[]): boolean {
  const parts = path.relative(binary.packageRoot, binary.file).split(path.sep)
  return (
    /\.so(?:\.|$)/.test(path.basename(binary.file)) &&
    parts.slice(0, -1).some((part) => part.startsWith('qvac__')) &&
    !binaries.some((parent) => parent.needed.includes(binary.soname ?? path.basename(binary.file)))
  )
}

export async function classifyNativeLibraries(
  binaries: NativeBinary[],
  resolveLibrary: (binary: NativeBinary, name: string) => Promise<boolean>,
  preloadResolves: (binary: NativeBinary, name: string) => boolean | Promise<boolean>
): Promise<NativeFindings> {
  const required = new Map<string, NativeLibraryFinding>()
  const optional = new Map<string, NativeLibraryFinding>()
  const packages = new Map<string, NativeLibraryFinding>()
  const add = (
    bucket: Map<string, NativeLibraryFinding>,
    name: string,
    binary: NativeBinary
  ): void => {
    const finding = bucket.get(name) ?? { name, requiredBy: [] }
    const requester = {
      package: binary.packageName,
      file: path.relative(binary.packageRoot, binary.file)
    }
    if (
      !finding.requiredBy.some(
        (entry) => entry.package === requester.package && entry.file === requester.file
      )
    ) {
      finding.requiredBy.push(requester)
    }
    bucket.set(name, finding)
  }
  for (const binary of binaries) {
    for (const name of binary.needed) {
      if (BARE_SONAME.test(name)) {
        if (!(await preloadResolves(binary, name))) add(packages, name, binary)
      } else if (!(await resolveLibrary(binary, name))) {
        if (
          binaries.some(
            (candidate) => candidate.soname === name || path.basename(candidate.file) === name
          )
        ) {
          add(packages, name, binary)
        } else if (isOptionalBackend(binary, binaries)) add(optional, name, binary)
        else add(required, name, binary)
      }
    }
  }
  for (const [name, finding] of optional) {
    const mandatory = required.get(name)
    if (mandatory !== undefined) {
      mandatory.requiredBy.push(...finding.requiredBy)
      optional.delete(name)
    }
  }
  const sorted = (bucket: Map<string, NativeLibraryFinding>): NativeLibraryFinding[] =>
    [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { required: sorted(required), optional: sorted(optional), packages: sorted(packages) }
}

export function nativeLibraryResults(findings: NativeFindings, count: number): CheckResult[] {
  const describe = (libraries: NativeLibraryFinding[]): string =>
    libraries
      .map(
        ({ name, requiredBy }) =>
          `${name} (${requiredBy.map((entry) => `${entry.package}/${entry.file}`).join(', ')})`
      )
      .join('; ')
  const checks: CheckResult[] = [
    {
      id: 'native-libraries',
      label: LABEL,
      severity: 'required',
      status: findings.required.length > 0 ? 'fail' : 'pass',
      value:
        findings.required.length > 0
          ? describe(findings.required)
          : `${count} native binaries checked`,
      ...(findings.required.length > 0
        ? {
            code: 'missing-system-library',
            hint: 'Install the packages that provide these libraries for this host, then rerun --deep.'
          }
        : {})
    }
  ]
  if (findings.optional.length > 0) {
    checks.push({
      id: 'native-optional-libraries',
      label: 'Optional GPU/RPC backend prerequisites',
      severity: 'recommended',
      status: 'warn',
      value: describe(findings.optional),
      hint: 'Only needed for the corresponding GPU or remote backend; local CPU use does not require these libraries.'
    })
  }
  if (findings.packages.length > 0) {
    checks.push({
      id: 'native-package-libraries',
      label: 'Package and Bare library resolution',
      severity: 'recommended',
      status: 'warn',
      value: describe(findings.packages),
      hint: 'These dependencies need package search paths or a Bare preload. Check the package installation and the heartbeat result; they are not missing system packages.'
    })
  }
  return checks
}

/** Opt-in, current-host preflight. Never changes the installed packages or starts native code. */
export async function checkNativeLibraries(projectRoot: string): Promise<CheckResult[]> {
  const skip = (value: string, hint?: string): CheckResult[] => [
    {
      id: 'native-libraries',
      label: LABEL,
      severity: 'recommended',
      status: 'skip',
      value,
      ...(hint ? { hint } : {})
    }
  ]
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    return skip('Linux x64/arm64 only')
  }
  const started = Date.now()
  const checkBudget = (): void => {
    if (Date.now() - started >= BUDGET_MS) throw new Error('Native prerequisite scan timed out')
  }
  const command = async (file: string, args: string[]): Promise<string> => {
    checkBudget()
    const { stdout } = await exec(file, args, {
      timeout: Math.max(1, Math.min(3_000, BUDGET_MS - (Date.now() - started))),
      maxBuffer: 1_048_576,
      env: { ...process.env, LC_ALL: 'C' }
    })
    return stdout
  }
  try {
    try {
      await command('readelf', ['--version'])
    } catch {
      return skip(
        'readelf unavailable',
        'Install binutils to enable this static check. The SDK heartbeat still runs.'
      )
    }
    const packages = await collectPackages(projectRoot, checkBudget)
    const binaries = await collectBinaries(
      packages,
      process.arch,
      (file) => readNativeDynamic(file, command),
      checkBudget
    )
    if (binaries.length === 0) return skip('No current-host native prebuilds found')
    const cache = new Map<string, string[]>()
    let cacheOutput = ''
    for (const program of ['ldconfig', '/sbin/ldconfig']) {
      try {
        cacheOutput = await command(program, ['-p'])
        break
      } catch {
        /* Default directories remain usable. */
      }
    }
    for (const match of cacheOutput.matchAll(/^\s*(\S+)\s+\([^\n]*\)\s+=>\s+(\S+)$/gm)) {
      const paths = cache.get(match[1]!) ?? []
      paths.push(match[2]!)
      cache.set(match[1]!, paths)
    }
    const triplet = process.arch === 'x64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu'
    const defaults = [
      '/lib',
      '/usr/lib',
      '/lib64',
      '/usr/lib64',
      `/lib/${triplet}`,
      `/usr/lib/${triplet}`
    ]
    const exists = new Map<string, boolean>()
    const compatible = async (file: string): Promise<boolean> => {
      if (!exists.has(file)) exists.set(file, await hostElf(file, process.arch))
      return exists.get(file)!
    }
    const resolve = async (binary: NativeBinary, name: string): Promise<boolean> => {
      checkBudget()
      return resolvesFrom(binary, name, {
        dirs: defaults,
        cache,
        projectRoot,
        exists: compatible,
        libraryPath: process.env['LD_LIBRARY_PATH']
      })
    }
    const findings = await classifyNativeLibraries(
      binaries,
      async (binary, name) => {
        if (await resolve(binary, name)) return true
        // Direct siblings in the same parent's DT_NEEDED list are loaded together.
        // This covers bundled libva used both by bare-ffmpeg and by libva-drm.
        for (const parent of binaries) {
          if (
            parent.packageRoot === binary.packageRoot &&
            parent.needed.includes(binary.soname ?? path.basename(binary.file)) &&
            parent.needed.includes(name) &&
            (await resolve(parent, name))
          ) {
            return true
          }
        }
        return false
      },
      (binary, name) => packageProvides(binary, name, binaries, packages)
    )
    return nativeLibraryResults(findings, binaries.length)
  } catch (error) {
    return [
      {
        id: 'native-libraries',
        label: LABEL,
        severity: 'recommended',
        status: 'warn',
        code: 'native-scan-incomplete',
        value: 'Static scan incomplete',
        hint: 'Use the SDK heartbeat result below; rerun with --verbose for scan details.',
        detail:
          error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000)
      }
    ]
  }
}
