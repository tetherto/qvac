import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { runAudit } from './audit.js'
import type { AuditedAnalysisResult } from './model.js'
import { buildTriageReport } from './triage.js'
import {
  renderTriageJson,
  renderTriageMarkdown,
  type TriageRenderOptions,
} from './triage-report.js'
import type { TriageReport } from './triage-model.js'

export interface WriteTriageArtifactsOptions {
  readonly root: string
  readonly audit: AuditedAnalysisResult
  readonly outputDirectory?: string
  readonly now?: Date
  readonly render?: TriageRenderOptions
}

export interface TriageArtifacts {
  readonly report: TriageReport
  readonly jsonPath: string
  readonly markdownPath: string
}

export async function writeTriageArtifacts(
  options: WriteTriageArtifactsOptions,
): Promise<TriageArtifacts> {
  if (options.audit.diagnostics.length > 0) {
    throw new Error(
      `Cannot triage ${formatCount(options.audit.diagnostics.length, 'analysis error')}`,
    )
  }
  const outputDirectory = options.outputDirectory ?? join(options.root, '.quality')
  const jsonPath = join(outputDirectory, 'triage.json')
  const markdownPath = join(outputDirectory, 'triage.md')
  const report = await buildTriageReport({
    audit: options.audit,
    root: options.root,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  await Promise.all([
    writeAtomically(jsonPath, renderTriageJson(report)),
    writeAtomically(markdownPath, renderTriageMarkdown(report, options.render)),
  ])
  return { report, jsonPath, markdownPath }
}

async function main(): Promise<void> {
  const root = resolve(process.cwd())
  const mode = process.argv[2] ?? 'fresh'
  const audit = mode === 'fresh'
    ? (await runAudit({ root, command: 'audit' })).result
    : mode === 'existing'
      ? parseAuditReport(await readFile(join(root, '.quality/report.json'), 'utf8'))
      : undefined
  if (audit === undefined) {
    throw new Error(`Unknown triage mode: ${mode}`)
  }
  const artifacts = await writeTriageArtifacts({ root, audit })
  process.stdout.write(
    `Code quality triage: ${artifacts.report.candidates.length} candidate groups.\n`,
  )
  process.stdout.write(`Triage: ${artifacts.markdownPath}\n`)
}

function parseAuditReport(source: string): AuditedAnalysisResult {
  const parsed: unknown = JSON.parse(source)
  if (
    !isRecord(parsed)
    || parsed.schemaVersion !== 1
    || !Array.isArray(parsed.coverage)
    || !Array.isArray(parsed.diagnostics)
    || !Array.isArray(parsed.findings)
    || !Array.isArray(parsed.changes)
    || !Array.isArray(parsed.resolved)
    || (parsed.resolutionStatus !== 'complete' && parsed.resolutionStatus !== 'withheld')
  ) {
    throw new Error('Audit report has an unsupported shape')
  }
  return parsed as unknown as AuditedAnalysisResult
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, content)
  await rename(temporaryPath, path)
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const invokedPath = process.argv[1]?.replaceAll('\\', '/') ?? ''
if (
  invokedPath.endsWith('/scripts/code-quality/triage-cli.ts')
  || invokedPath.endsWith('/scripts/code-quality/triage-cli.js')
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Code-quality triage failed: ${message}\n`)
    process.exitCode = 1
  })
}
