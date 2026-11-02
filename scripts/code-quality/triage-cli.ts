import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { runAudit } from './audit.js'
import {
  compareWithBaseline,
  createBaseline,
  parseBaseline,
} from './baseline.js'
import type { AuditedAnalysisResult, Baseline } from './model.js'
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

export interface RecurringTriageArtifacts extends TriageArtifacts {
  readonly audit: AuditedAnalysisResult
  readonly snapshotPath: string
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

export async function writeRecurringTriageArtifacts(
  options: WriteTriageArtifactsOptions & { readonly snapshotPath?: string },
): Promise<RecurringTriageArtifacts> {
  const snapshotPath = options.snapshotPath
    ?? join(options.root, '.quality/previous-run-baseline.json')
  const previousSnapshot = await loadOptionalBaseline(snapshotPath)
  const currentFindings = options.audit.findings.map(({ finding }) => finding)
  const audit = previousSnapshot === undefined
    ? options.audit
    : {
      schemaVersion: 1 as const,
      coverage: options.audit.coverage,
      diagnostics: options.audit.diagnostics,
      ...compareWithBaseline(
        currentFindings,
        previousSnapshot,
        options.audit.diagnostics.length === 0 ? 'calculate' : 'withhold',
      ),
    }
  const artifacts = await writeTriageArtifacts({
    root: options.root,
    audit,
    ...(options.outputDirectory === undefined
      ? {}
      : { outputDirectory: options.outputDirectory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.render === undefined ? {} : { render: options.render }),
  })
  await writeAtomically(
    snapshotPath,
    `${JSON.stringify(createBaseline(currentFindings), undefined, 2)}\n`,
  )
  return { ...artifacts, audit, snapshotPath }
}

async function main(): Promise<void> {
  const root = resolve(process.cwd())
  const mode = process.argv[2] ?? 'fresh'
  let artifacts: TriageArtifacts
  if (mode === 'fresh') {
    const audit = (await runAudit({ root, command: 'audit' })).result
    artifacts = await writeRecurringTriageArtifacts({ root, audit })
  } else if (mode === 'existing') {
    const audit = parseAuditReport(
      await readFile(join(root, '.quality/report.json'), 'utf8'),
    )
    artifacts = await writeTriageArtifacts({ root, audit })
  } else {
    throw new Error(`Unknown triage mode: ${mode}`)
  }
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

async function loadOptionalBaseline(path: string): Promise<Baseline | undefined> {
  try {
    return parseBaseline(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined
    }
    throw error
  }
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
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
