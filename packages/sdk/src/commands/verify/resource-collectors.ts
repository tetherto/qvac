import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import tarStream, { type Pack } from 'tar-stream'
import { collectAddonsFromBundle } from '@/commands/verify/bundle-source'
import { listBarePrebuildFiles } from '@/commands/verify/prebuilds'

export const RESOURCE_COLLECTOR_PACKAGES = ['bare-cpu-info', 'bare-gpu-info'] as const
export const RESOURCE_COLLECTOR_SIZE_BUDGETS = {
  compressedBytes: 2 * 1024 * 1024,
  uncompressedBytes: 5 * 1024 * 1024
} as const

export interface ResourceCollectorAcceptanceOptions {
  projectRoot: string
  bundlePath: string
  hosts: string[]
  budgets?: ResourceCollectorSizeBudgets
}

export interface ResourceCollectorSizeBudgets {
  compressedBytes: number
  uncompressedBytes: number
}

export interface ResourceCollectorTargetMeasurement {
  host: string
  files: Array<{
    package: string
    relativePath: string
    bytes: number
  }>
  compressedBytes: number
  uncompressedBytes: number
}

export interface ResourceCollectorAcceptanceReport {
  ok: boolean
  collectors: string[]
  hosts: string[]
  budgets: ResourceCollectorSizeBudgets
  targets: ResourceCollectorTargetMeasurement[]
  issues: ResourceCollectorAcceptanceIssue[]
}

export type ResourceCollectorAcceptanceIssue =
  | {
      code: 'missing-collector'
      level: 'error'
      package: string
      message: string
    }
  | {
      code: 'missing-prebuild'
      level: 'error'
      package: string
      host: string
      message: string
    }
  | {
      code: 'measurement-failed'
      level: 'error'
      package: string
      host: string
      message: string
    }
  | {
      code: 'compressed-budget-exceeded' | 'uncompressed-budget-exceeded'
      level: 'error'
      host: string
      actualBytes: number
      budgetBytes: number
      message: string
    }

interface MeasurementEntry {
  package: string
  relativePath: string
  bytes: number
  contents: Buffer
}

interface ResourceCollectorMeasurementDependencies {
  writeArchiveEntry: (pack: Pack, entry: MeasurementEntry) => Promise<void>
}

const DEFAULT_MEASUREMENT_DEPENDENCIES: ResourceCollectorMeasurementDependencies = {
  writeArchiveEntry
}

export async function acceptResourceCollectorPackaging(
  options: ResourceCollectorAcceptanceOptions
): Promise<ResourceCollectorAcceptanceReport> {
  const addons = await collectAddonsFromBundle({
    bundlePath: options.bundlePath,
    projectRoot: options.projectRoot,
    hosts: options.hosts
  })
  const collectors = new Map(
    addons
      .filter((addon) => isResourceCollectorPackage(addon.name))
      .map((addon) => [addon.name, addon])
  )
  const issues: ResourceCollectorAcceptanceIssue[] = []
  const entriesByHost = new Map(options.hosts.map((host) => [host, [] as MeasurementEntry[]]))
  const budgets = options.budgets ?? RESOURCE_COLLECTOR_SIZE_BUDGETS

  for (const packageName of RESOURCE_COLLECTOR_PACKAGES) {
    const collector = collectors.get(packageName)
    if (collector === undefined) {
      issues.push({
        code: 'missing-collector',
        level: 'error',
        package: packageName,
        message: `${packageName} is missing from the linked worker bundle graph.`
      })
      continue
    }

    for (const host of options.hosts) {
      const hostDir = path.join(collector.packageRoot, 'prebuilds', host)
      const files = await listBarePrebuildFiles(hostDir)
      if (files.length === 0) {
        issues.push({
          code: 'missing-prebuild',
          level: 'error',
          package: packageName,
          host,
          message:
            `${packageName} is missing a prebuild for ${host} ` +
            `(expected ${path.join(hostDir, '*.bare')}).`
        })
        continue
      }

      for (const file of files) {
        try {
          const contents = await fsp.readFile(file)
          entriesByHost.get(host)?.push({
            package: packageName,
            relativePath: normalizeArchivePath(path.relative(collector.packageRoot, file)),
            bytes: contents.byteLength,
            contents
          })
        } catch (error) {
          issues.push(measurementFailedIssue(packageName, host, error))
        }
      }
    }
  }

  const targets: ResourceCollectorTargetMeasurement[] = []
  for (const host of options.hosts) {
    const entries = entriesByHost.get(host) ?? []
    entries.sort(compareMeasurementEntries)
    try {
      const target = await measureTarget(host, entries)
      targets.push(target)
      applyBudgets(target, budgets, issues)
    } catch (error) {
      issues.push(
        measurementFailedIssue(entries[0]?.package ?? RESOURCE_COLLECTOR_PACKAGES[0], host, error)
      )
    }
  }

  return {
    ok: issues.length === 0,
    collectors: [...RESOURCE_COLLECTOR_PACKAGES],
    hosts: [...options.hosts],
    budgets,
    targets,
    issues
  }
}

export function formatResourceCollectorAcceptanceReport(
  report: ResourceCollectorAcceptanceReport
): string {
  const lines = [
    `Resource collector packaging: ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.targets.map(
      (target) =>
        `${target.host}: ${target.compressedBytes} compressed / ` +
        `${target.uncompressedBytes} uncompressed`
    ),
    `Budgets: ${formatMebibytes(report.budgets.compressedBytes)} compressed / ` +
      `${formatMebibytes(report.budgets.uncompressedBytes)} uncompressed`
  ]

  for (const issue of report.issues) {
    const details: string[] = [issue.code]
    if ('host' in issue) details.push(`host: ${issue.host}`)
    if ('package' in issue) details.push(`package: ${issue.package}`)
    if ('actualBytes' in issue) details.push(`actual: ${issue.actualBytes} bytes`)
    if ('budgetBytes' in issue) details.push(`limit: ${issue.budgetBytes} bytes`)
    details.push(issue.message)
    lines.push(`- ${details.join(' | ')}`)
  }

  return lines.join('\n')
}

function formatMebibytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function normalizeArchivePath(filePath: string) {
  return filePath.replaceAll(path.sep, path.posix.sep)
}

function compareMeasurementEntries(left: MeasurementEntry, right: MeasurementEntry) {
  const leftPath = `${left.package}/${left.relativePath}`
  const rightPath = `${right.package}/${right.relativePath}`
  if (leftPath < rightPath) return -1
  if (leftPath > rightPath) return 1
  return 0
}

export async function measureTarget(
  host: string,
  entries: MeasurementEntry[],
  dependencies: ResourceCollectorMeasurementDependencies = DEFAULT_MEASUREMENT_DEPENDENCIES
) {
  const pack = tarStream.pack()
  const gzip = createGzip({ level: 9 })
  const compressedBytesPromise = countStreamBytes(gzip)
  pack.pipe(gzip)

  try {
    for (const entry of entries) {
      await dependencies.writeArchiveEntry(pack, entry)
    }
    pack.finalize()
  } catch (error) {
    pack.destroy()
    gzip.destroy()
    await compressedBytesPromise.catch(() => {})
    throw error
  }

  return {
    host,
    files: entries.map(({ package: packageName, relativePath, bytes }) => ({
      package: packageName,
      relativePath,
      bytes
    })),
    compressedBytes: await compressedBytesPromise,
    uncompressedBytes: entries.reduce((total, entry) => total + entry.bytes, 0)
  }
}

async function writeArchiveEntry(pack: Pack, entry: MeasurementEntry) {
  await new Promise<void>((resolve, reject) => {
    pack.entry(
      {
        name: `${entry.package}/${entry.relativePath}`,
        mode: 0o644,
        size: entry.bytes,
        mtime: new Date(0)
      },
      entry.contents,
      (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      }
    )
  })
}

async function countStreamBytes(stream: NodeJS.ReadableStream) {
  let bytes = 0
  for await (const chunk of stream) bytes += Buffer.byteLength(chunk)
  return bytes
}

function applyBudgets(
  target: ResourceCollectorTargetMeasurement,
  budgets: ResourceCollectorSizeBudgets,
  issues: ResourceCollectorAcceptanceIssue[]
) {
  if (target.compressedBytes > budgets.compressedBytes) {
    issues.push({
      code: 'compressed-budget-exceeded',
      level: 'error',
      host: target.host,
      actualBytes: target.compressedBytes,
      budgetBytes: budgets.compressedBytes,
      message:
        `${target.host} resource collectors use ${target.compressedBytes} compressed bytes ` +
        `(limit: ${budgets.compressedBytes}).`
    })
  }

  if (target.uncompressedBytes > budgets.uncompressedBytes) {
    issues.push({
      code: 'uncompressed-budget-exceeded',
      level: 'error',
      host: target.host,
      actualBytes: target.uncompressedBytes,
      budgetBytes: budgets.uncompressedBytes,
      message:
        `${target.host} resource collectors use ${target.uncompressedBytes} uncompressed bytes ` +
        `(limit: ${budgets.uncompressedBytes}).`
    })
  }
}

function measurementFailedIssue(
  packageName: string,
  host: string,
  cause: unknown
): ResourceCollectorAcceptanceIssue {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return {
    code: 'measurement-failed',
    level: 'error',
    package: packageName,
    host,
    message: `Could not measure ${packageName} for ${host}: ${reason}.`
  }
}

function isResourceCollectorPackage(
  packageName: string
): packageName is (typeof RESOURCE_COLLECTOR_PACKAGES)[number] {
  return RESOURCE_COLLECTOR_PACKAGES.some((collector) => collector === packageName)
}
