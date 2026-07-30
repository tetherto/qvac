import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleSdk, type BundleSdkOptions, type BundleSdkResult } from '@/commands/bundle/index'
import {
  acceptResourceCollectorPackaging,
  formatResourceCollectorAcceptanceReport,
  type ResourceCollectorAcceptanceOptions,
  type ResourceCollectorAcceptanceReport
} from '@/commands/verify/resource-collectors'
import { RequestValidationFailedError } from '@/utils/errors-client'

const DESKTOP_HOSTS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
] as const

type DesktopHost = (typeof DESKTOP_HOSTS)[number]

export interface ResourceCollectorCheckArgs {
  hosts: DesktopHost[]
  json: boolean
}

export interface ResourceCollectorCheckOptions extends ResourceCollectorCheckArgs {
  sdkPackageRoot: string
  platform?: NodeJS.Platform
  arch?: string
}

export interface ResourceCollectorCheckDependencies {
  createTemporaryProject: (sdkPackageRoot: string) => Promise<string>
  removeTemporaryProject: (projectRoot: string) => Promise<void>
  bundleSdk: (options: BundleSdkOptions) => Promise<BundleSdkResult>
  acceptResourceCollectorPackaging: (
    options: ResourceCollectorAcceptanceOptions
  ) => Promise<ResourceCollectorAcceptanceReport>
  formatResourceCollectorAcceptanceReport: (report: ResourceCollectorAcceptanceReport) => string
  writeOutput: (output: string) => void
  writeError: (output: string) => void
  setExitCode: (exitCode: number) => void
}

export interface ResourceCollectorCliOptions {
  sdkPackageRoot?: string
  dependencies?: ResourceCollectorCheckDependencies
}

const DEFAULT_DEPENDENCIES: ResourceCollectorCheckDependencies = {
  createTemporaryProject,
  removeTemporaryProject,
  bundleSdk,
  acceptResourceCollectorPackaging,
  formatResourceCollectorAcceptanceReport,
  writeOutput(output) {
    console.log(output)
  },
  writeError(output) {
    console.error(output)
  },
  setExitCode(exitCode) {
    process.exitCode = exitCode
  }
}

export function parseResourceCollectorCheckArgs(args: string[]): ResourceCollectorCheckArgs {
  const hosts: DesktopHost[] = []
  const seenHosts = new Set<DesktopHost>()
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--host') {
      const host = args[index + 1]
      if (host === undefined || host.startsWith('--')) {
        throw new RequestValidationFailedError('--host requires a platform-architecture value')
      }
      const desktopHost = validateDesktopHost(host)
      if (!seenHosts.has(desktopHost)) {
        seenHosts.add(desktopHost)
        hosts.push(desktopHost)
      }
      index += 1
      continue
    }
    throw new RequestValidationFailedError(`Unknown argument: ${argument}`)
  }

  return { hosts, json }
}

export function resolveDesktopHost(platform: NodeJS.Platform, arch: string): DesktopHost {
  return validateDesktopHost(`${platform}-${arch}`)
}

export async function runResourceCollectorPackagingCheck(
  options: ResourceCollectorCheckOptions,
  dependencies: ResourceCollectorCheckDependencies = DEFAULT_DEPENDENCIES
) {
  const hosts =
    options.hosts.length > 0
      ? options.hosts
      : [resolveDesktopHost(options.platform ?? process.platform, options.arch ?? process.arch)]
  const temporaryProjectRoot = await dependencies.createTemporaryProject(options.sdkPackageRoot)

  try {
    const bundle = await dependencies.bundleSdk({
      projectRoot: temporaryProjectRoot,
      sdkPath: options.sdkPackageRoot,
      hosts,
      quiet: true
    })
    const report = await dependencies.acceptResourceCollectorPackaging({
      projectRoot: temporaryProjectRoot,
      bundlePath: bundle.bundlePath,
      manifestPath: bundle.manifestPath,
      hosts
    })
    const output = options.json
      ? JSON.stringify(report, null, 2)
      : dependencies.formatResourceCollectorAcceptanceReport(report)
    dependencies.writeOutput(output)
    if (!report.ok) dependencies.setExitCode(1)
  } finally {
    await dependencies.removeTemporaryProject(temporaryProjectRoot)
  }
}

export async function runResourceCollectorPackagingCli(
  args: string[],
  options: ResourceCollectorCliOptions = {}
) {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES
  try {
    await runResourceCollectorPackagingCheck(
      {
        sdkPackageRoot: options.sdkPackageRoot ?? resolveSdkPackageRoot(),
        ...parseResourceCollectorCheckArgs(args)
      },
      dependencies
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.split('\n').filter(Boolean).at(-1) ?? message
    dependencies.writeError(`Resource collector packaging check failed: ${reason}`)
    dependencies.setExitCode(1)
  }
}

function validateDesktopHost(host: string): DesktopHost {
  const desktopHost = DESKTOP_HOSTS.find((candidate) => candidate === host)
  if (desktopHost === undefined) {
    throw new RequestValidationFailedError(
      `Unsupported host "${host}". Expected one of: ${DESKTOP_HOSTS.join(', ')}`
    )
  }
  return desktopHost
}

async function createTemporaryProject(sdkPackageRoot: string) {
  const projectRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qvac-resource-collectors-packaging-')
  )
  try {
    await fsp.symlink(
      path.join(sdkPackageRoot, 'node_modules'),
      path.join(projectRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    return projectRoot
  } catch (error) {
    await removeTemporaryProject(projectRoot)
    throw error
  }
}

async function removeTemporaryProject(projectRoot: string) {
  await fsp.rm(projectRoot, { recursive: true, force: true })
}

function resolveSdkPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function isMainModule() {
  const entryPath = process.argv[1]
  return entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  await runResourceCollectorPackagingCli(process.argv.slice(2))
}
