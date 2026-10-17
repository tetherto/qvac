import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { resolveSdkEntrypoint } from '@/doctor/checks/project'
import type { CheckResult } from '@/doctor/types'

const exec = promisify(execFile)
const LABEL = 'Linux native prerequisites'
const BARE_SONAME = /@\d+\.bare$/
const OPTIONAL_BACKEND = /(?:^|-)ggml-(?:vulkan|cuda|hip|sycl|opencl|rpc)\.so(?:\.|$)/
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
  needed: string[]
  soname?: string | undefined
  searchPaths: string[]
}
export interface NativeFindings {
  required: string[]
  optional: string[]
  packages: string[]
}

/** Read dynamic metadata without executing an installed binary (unlike ldd). */
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

async function hostElf(file: string, arch: string): Promise<boolean> {
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

async function packageForEntry(entry: string): Promise<NativePackage> {
  let dir = path.dirname(entry)
  for (;;) {
    try {
      return await readPackage(dir)
    } catch {
      /* Find the package enclosing its entry point. */
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('SDK package root not found')
    dir = parent
  }
}

async function resolveDependency(pkg: NativePackage, name: string): Promise<NativePackage | null> {
  const req = createRequire(path.join(pkg.root, 'package.json'))
  for (const spec of [`${name}/package.json`, `${name}/package`, name]) {
    try {
      const found = await packageForEntry(req.resolve(spec))
      if (found.manifest.name === name) return found
    } catch {
      /* Optional platform packages may not be installed. */
    }
  }
  return null
}

async function collectPackages(entry: string, checkBudget: () => void): Promise<NativePackage[]> {
  const first = await packageForEntry(entry)
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
  inspect: (file: string) => Promise<string>,
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
        binaries.push({ file, packageRoot: pkg.root, ...parseNativeDynamic(await inspect(file)) })
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

// Fabric is preloaded through the consumer's binding, then reused by SONAME.
// A matching filename elsewhere in node_modules is not proof of this contract.
export async function fabricPreloaded(
  binary: NativeBinary,
  soname: string,
  binaries: NativeBinary[],
  packages: NativePackage[]
): Promise<boolean> {
  if (!/^qvac__fabric(?:-linux-(?:x64|arm64))?@\d+\.bare$/.test(soname)) return false
  const consumer = packages.find((pkg) => pkg.root === binary.packageRoot)
  const fabric = consumer?.dependencies.find((pkg) => pkg.manifest.name === '@qvac/fabric')
  if (fabric === undefined) return false
  let binding: string
  try {
    binding = await fs.readFile(path.join(consumer!.root, 'binding.js'), 'utf8')
  } catch {
    return false
  }
  // Strip comments so a documented/example require cannot satisfy the check.
  binding = binding.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  if (
    !/^\s*(?:['"]use strict['"]\s*;?\s*)?require\(\s*['"]@qvac\/fabric['"]\s*\)\s*;?\s*module\.exports\s*=\s*require\.addon\(\)\s*;?\s*$/.test(
      binding
    )
  ) {
    return false
  }
  const providers = new Set([fabric.root, ...fabric.dependencies.map((pkg) => pkg.root)])
  return binaries.some(
    (candidate) => candidate.soname === soname && providers.has(candidate.packageRoot)
  )
}

export async function classifyNativeLibraries(
  binaries: NativeBinary[],
  resolveLibrary: (binary: NativeBinary, name: string) => Promise<boolean>,
  preloadResolves: (binary: NativeBinary, name: string) => Promise<boolean>
): Promise<NativeFindings> {
  const required = new Set<string>()
  const optional = new Set<string>()
  const packages = new Set<string>()
  for (const binary of binaries) {
    for (const name of binary.needed) {
      if (BARE_SONAME.test(name)) {
        if (!(await preloadResolves(binary, name))) packages.add(name)
      } else if (!(await resolveLibrary(binary, name))) {
        if (
          binaries.some(
            (candidate) => candidate.soname === name || path.basename(candidate.file) === name
          )
        ) {
          packages.add(name)
        } else if (OPTIONAL_BACKEND.test(path.basename(binary.file))) optional.add(name)
        else required.add(name)
      }
    }
  }
  return {
    required: [...required].sort(),
    optional: [...optional].filter((name) => !required.has(name)).sort(),
    packages: [...packages].sort()
  }
}

export function nativeLibraryResults(findings: NativeFindings, count: number): CheckResult[] {
  const checks: CheckResult[] = [
    {
      id: 'native-libraries',
      label: LABEL,
      severity: 'required',
      status: findings.required.length > 0 ? 'fail' : 'pass',
      value:
        findings.required.length > 0
          ? findings.required.join(', ')
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
      value: findings.optional.join(', '),
      hint: 'Only needed for the corresponding GPU or remote backend; local CPU use does not require these libraries.'
    })
  }
  if (findings.packages.length > 0) {
    checks.push({
      id: 'native-package-libraries',
      label: 'Package and Bare library resolution',
      severity: 'recommended',
      status: 'warn',
      value: findings.packages.join(', '),
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
      timeout: Math.min(3_000, BUDGET_MS - (Date.now() - started)),
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
    const packages = await collectPackages(resolveSdkEntrypoint(projectRoot), checkBudget)
    const binaries = await collectBinaries(
      packages,
      process.arch,
      (file) => command('readelf', ['-dW', '--', file]),
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
    // $ORIGIN in LD_LIBRARY_PATH is relative to the executable, not each addon.
    // Leave other dynamic-loader tokens to the heartbeat rather than guess.
    if (
      (process.env['LD_LIBRARY_PATH'] ?? '').includes('$') ||
      binaries.some((binary) =>
        binary.searchPaths.some((dir) => dir.replace(/\$\{ORIGIN\}|\$ORIGIN\b/g, '').includes('$'))
      )
    ) {
      throw new Error('Unsupported dynamic-loader path token; static resolution is incomplete')
    }
    const exists = new Map<string, boolean>()
    const compatible = async (file: string): Promise<boolean> => {
      if (!exists.has(file)) exists.set(file, await hostElf(file, process.arch))
      return exists.get(file)!
    }
    const resolvesFrom = async (binary: NativeBinary, name: string): Promise<boolean> => {
      checkBudget()
      const origin = path.dirname(binary.file)
      const expand = (value: string): string => value.replace(/\$\{ORIGIN\}|\$ORIGIN\b/g, origin)
      const dirs = [
        ...(process.env['LD_LIBRARY_PATH']?.split(':') ?? []),
        ...binary.searchPaths,
        ...defaults
      ].map(expand)
      const candidates = name.includes('/')
        ? [path.resolve(projectRoot, expand(name))]
        : [
            ...dirs
              .filter((dir) => !dir.includes('$'))
              .map((dir) => path.resolve(projectRoot, dir, name)),
            ...(cache.get(name) ?? [])
          ]
      for (const file of candidates) if (await compatible(file)) return true
      return false
    }
    const findings = await classifyNativeLibraries(
      binaries,
      async (binary, name) => {
        if (await resolvesFrom(binary, name)) return true
        // Direct siblings in the same parent's DT_NEEDED list are loaded together.
        // This covers bundled libva used both by bare-ffmpeg and by libva-drm.
        for (const parent of binaries) {
          if (
            parent.packageRoot === binary.packageRoot &&
            parent.needed.includes(binary.soname ?? path.basename(binary.file)) &&
            parent.needed.includes(name) &&
            (await resolvesFrom(parent, name))
          ) {
            return true
          }
        }
        return false
      },
      (binary, name) => fabricPreloaded(binary, name, binaries, packages)
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
