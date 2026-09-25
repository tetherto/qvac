import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  compareWithBaseline,
  createBaseline,
  parseBaseline,
} from './baseline.js'
import { stableErrorMessage } from './diagnostics.js'
import { analyzeDependencies } from './detectors/dependencies.js'
import { analyzeStructure } from './detectors/structure.js'
import { discoverSourceFiles } from './files.js'
import { analyzeWorkspaceCycles } from './graph.js'
import type {
  AnalysisDiagnostic,
  AnalysisResult,
  AuditedAnalysisResult,
  Baseline,
  DetectorCoverage,
  Finding,
} from './model.js'
import { renderJson, renderMarkdown } from './report.js'

export interface DetectorContext {
  readonly root: string
  readonly files: readonly string[]
}

export interface DetectorAdapter {
  readonly id: string
  readonly analyze: (context: DetectorContext) => Promise<AnalysisResult>
}

export interface AuditOptions {
  readonly root: string
  readonly command: 'audit' | 'baseline'
  readonly baselinePath?: string
  readonly outputDirectory?: string
  readonly detectors?: readonly DetectorAdapter[]
  readonly files?: readonly string[]
}

export interface AuditRun {
  readonly exitCode: 0 | 1
  readonly result: AuditedAnalysisResult
  readonly markdownPath: string
  readonly jsonPath: string
  readonly baselinePath: string
}

export async function runAudit(options: AuditOptions): Promise<AuditRun> {
  const baselinePath = options.baselinePath
    ?? join(options.root, 'scripts/code-quality/baseline.json')
  const outputDirectory = options.outputDirectory
    ?? join(options.root, '.quality')
  const markdownPath = join(outputDirectory, 'report.md')
  const jsonPath = join(outputDirectory, 'report.json')
  const detectors = options.detectors ?? defaultDetectors()
  const files = options.files ?? (
    options.detectors === undefined
      ? await discoverSourceFiles(options.root)
      : []
  )
  const analysis = await runDetectors(detectors, { root: options.root, files })
  const baseline = options.command === 'baseline'
    ? createBaseline([])
    : await loadBaseline(baselinePath)
  const comparison = compareWithBaseline(
    analysis.findings,
    baseline,
    analysis.diagnostics.length === 0 ? 'calculate' : 'withhold',
  )
  const result: AuditedAnalysisResult = {
    schemaVersion: 1,
    coverage: analysis.coverage,
    diagnostics: analysis.diagnostics,
    ...comparison,
  }

  await Promise.all([
    writeAtomically(markdownPath, renderMarkdown(result)),
    writeAtomically(jsonPath, renderJson(result)),
  ])

  if (options.command === 'baseline' && analysis.diagnostics.length === 0) {
    const nextBaseline = createBaseline(analysis.findings)
    await writeAtomically(
      baselinePath,
      `${JSON.stringify(nextBaseline, undefined, 2)}\n`,
    )
  }

  return {
    exitCode: analysis.diagnostics.length === 0 ? 0 : 1,
    result,
    markdownPath,
    jsonPath,
    baselinePath,
  }
}

function defaultDetectors(): readonly DetectorAdapter[] {
  return [
    {
      id: 'structure',
      analyze: ({ root, files }) => analyzeStructure({ root, files }),
    },
    {
      id: 'dependencies',
      analyze: ({ root, files }) => analyzeDependencies({ root, files }),
    },
    {
      id: 'workspace-graph',
      analyze: ({ root }) => analyzeWorkspaceCycles(root),
    },
  ]
}

async function runDetectors(
  detectors: readonly DetectorAdapter[],
  context: DetectorContext,
): Promise<AnalysisResult> {
  const coverage: DetectorCoverage[] = []
  const findings: Finding[] = []
  const diagnostics: AnalysisDiagnostic[] = []

  for (const detector of detectors) {
    try {
      const result = await detector.analyze(context)
      coverage.push(...result.coverage)
      findings.push(...result.findings)
      diagnostics.push(...result.diagnostics)
    } catch (error) {
      diagnostics.push({
        detector: detector.id,
        code: 'detector-failure',
        message: stableErrorMessage(error, context.root),
      })
    }
  }

  return {
    schemaVersion: 1,
    coverage: coverage.sort(compareCoverage),
    findings: findings.sort(compareFindings),
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

async function loadBaseline(path: string): Promise<Baseline> {
  try {
    return parseBaseline(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissingFile(error)) {
      return createBaseline([])
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}

function compareCoverage(left: DetectorCoverage, right: DetectorCoverage): number {
  return `${left.detector}\u0000${left.version}`.localeCompare(
    `${right.detector}\u0000${right.version}`,
    'en',
  )
}

function compareFindings(left: Finding, right: Finding): number {
  return [left.primaryLocation.path, left.detector, left.rule]
    .join('\u0000')
    .localeCompare(
      [right.primaryLocation.path, right.detector, right.rule].join('\u0000'),
      'en',
    )
}

function compareDiagnostics(
  left: AnalysisDiagnostic,
  right: AnalysisDiagnostic,
): number {
  return [left.detector, left.code, left.location?.path ?? '', left.message]
    .join('\u0000')
    .localeCompare(
      [right.detector, right.code, right.location?.path ?? '', right.message]
        .join('\u0000'),
      'en',
    )
}
