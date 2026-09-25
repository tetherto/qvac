import { access, realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { ICruiseResult, IDependency } from 'dependency-cruiser'

import {
  FAN_OUT_THRESHOLDS,
  UNRESOLVED_IMPORT_EXEMPTIONS,
} from '../config.js'
import { canonicalDirectedCycle } from '../fingerprint.js'
import { classifySourceFile } from '../files.js'
import type {
  AnalysisDiagnostic,
  AnalysisResult,
  Finding,
  FindingSeverity,
} from '../model.js'

export interface DependencyAnalysisContext {
  readonly root: string
  readonly files: readonly string[]
  readonly tsConfig?: string
}

const DEPENDENCY_CRUISER_VERSION = '18.4.0'

export async function analyzeDependencies(
  context: DependencyAnalysisContext,
): Promise<AnalysisResult> {
  if (context.files.length === 0) {
    return emptyResult()
  }

  const baseDir = await realpath(context.root)
  const groups = context.tsConfig === undefined
    ? await groupByNearestTsConfig(baseDir, context.files)
    : [{ files: context.files, tsConfig: context.tsConfig }]
  const findingByIdentity = new Map<string, Finding>()
  const diagnosticByIdentity = new Map<string, AnalysisDiagnostic>()
  const modulesAnalyzed = new Set<string>()
  let unresolvedImportsExempted = 0

  for (const group of groups) {
    const combinedOutput = await cruiseGroup(baseDir, group, 'combined')
    const runtimeOutput = await cruiseGroup(baseDir, group, 'runtime')
    for (const module of combinedOutput.modules) {
      if (!module.source.includes('node_modules')) {
        modulesAnalyzed.add(module.source)
      }
    }
    const runtimeCycles = cycleFindings(runtimeOutput, 'runtime')
    const runtimeCycleIdentities = new Set(
      runtimeCycles.map(cycleIdentity),
    )
    const compileTimeCycles = cycleFindings(combinedOutput, 'compile-time')
      .filter((finding) => !runtimeCycleIdentities.has(cycleIdentity(finding)))
    for (const finding of [
      ...runtimeCycles,
      ...compileTimeCycles,
      ...fanOutFindings(combinedOutput),
    ]) {
      const key = `${finding.detector}\u0000${finding.rule}\u0000${JSON.stringify(finding.subject)}`
      const current = findingByIdentity.get(key)
      if (
        current === undefined
        || (finding.measurement?.value ?? 0) > (current.measurement?.value ?? 0)
      ) {
        findingByIdentity.set(key, finding)
      }
    }
    const unresolved = analyzeUnresolvedImports(combinedOutput)
    unresolvedImportsExempted += unresolved.exempted
    for (const diagnostic of unresolved.diagnostics) {
      const key = `${diagnostic.location?.path ?? ''}\u0000${diagnostic.message}`
      diagnosticByIdentity.set(key, diagnostic)
    }
  }

  const findings = [...findingByIdentity.values()].sort(compareFindings)
  const diagnostics = [...diagnosticByIdentity.values()].sort(compareDiagnostics)

  return {
    schemaVersion: 1,
    coverage: [
      {
        detector: 'dependencies',
        version: DEPENDENCY_CRUISER_VERSION,
        modulesAnalyzed: modulesAnalyzed.size,
        unresolvedImportsExempted,
      },
    ],
    findings,
    diagnostics,
  }
}

interface DependencyGroup {
  readonly files: readonly string[]
  readonly tsConfig?: string
}

async function cruiseGroup(
  baseDir: string,
  group: DependencyGroup,
  dependencyMode: 'combined' | 'runtime',
): Promise<ICruiseResult> {
  const { cruise } = await import('dependency-cruiser')
  const transpileOptions = group.tsConfig === undefined
    ? undefined
    : {
      tsConfig: (await import(
        'dependency-cruiser/config-utl/extract-ts-config'
      )).default(join(baseDir, group.tsConfig)),
    }
  const report = await cruise(
    [...group.files].sort(compareStrings),
    {
      baseDir,
      combinedDependencies: true,
      doNotFollow: { path: 'node_modules' },
      outputType: 'json',
      tsPreCompilationDeps: dependencyMode === 'combined' ? 'specify' : false,
      exclude: '(^|/)(?:build|coverage|dist|prebuilds)/',
      extraExtensionsToScan: ['.json'],
      ...(group.tsConfig === undefined
        ? {}
        : { tsConfig: { fileName: join(baseDir, group.tsConfig) } }),
    },
    undefined,
    transpileOptions,
  )

  return parseCruiseOutput(report.output)
}

async function groupByNearestTsConfig(
  root: string,
  files: readonly string[],
): Promise<readonly DependencyGroup[]> {
  const configByDirectory = new Map<string, string | undefined>()
  const filesByConfig = new Map<string, string[]>()

  for (const file of [...files].sort(compareStrings)) {
    const tsConfig = await nearestTsConfig(root, posix.dirname(file), configByDirectory)
    const key = tsConfig ?? ''
    const groupedFiles = filesByConfig.get(key) ?? []
    groupedFiles.push(file)
    filesByConfig.set(key, groupedFiles)
  }

  return [...filesByConfig.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([tsConfig, groupedFiles]) => ({
      files: groupedFiles,
      ...(tsConfig === '' ? {} : { tsConfig }),
    }))
}

async function nearestTsConfig(
  root: string,
  startDirectory: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  const visited: string[] = []
  let directory = startDirectory === '.' ? '' : startDirectory

  while (true) {
    if (cache.has(directory)) {
      const cached = cache.get(directory)
      for (const visitedDirectory of visited) {
        cache.set(visitedDirectory, cached)
      }
      return cached
    }

    visited.push(directory)
    const candidate = directory === ''
      ? 'tsconfig.json'
      : `${directory}/tsconfig.json`
    if (await fileExists(join(root, candidate))) {
      for (const visitedDirectory of visited) {
        cache.set(visitedDirectory, candidate)
      }
      return candidate
    }
    if (directory === '') {
      for (const visitedDirectory of visited) {
        cache.set(visitedDirectory, undefined)
      }
      return undefined
    }
    const parent = posix.dirname(directory)
    directory = parent === '.' ? '' : parent
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function emptyResult(): AnalysisResult {
  return {
    schemaVersion: 1,
    coverage: [
      {
        detector: 'dependencies',
        version: DEPENDENCY_CRUISER_VERSION,
        modulesAnalyzed: 0,
      },
    ],
    findings: [],
    diagnostics: [],
  }
}

function parseCruiseOutput(output: ICruiseResult | string): ICruiseResult {
  if (typeof output !== 'string') {
    return output
  }

  const parsed: unknown = JSON.parse(output)
  if (!isRecord(parsed) || !Array.isArray(parsed.modules)) {
    throw new Error('dependency-cruiser returned an invalid JSON report')
  }
  return parsed as unknown as ICruiseResult
}

function cycleFindings(
  output: ICruiseResult,
  cycleKind: 'compile-time' | 'runtime',
): readonly Finding[] {
  const findings = new Map<string, Finding>()
  const rule = cycleKind === 'runtime' ? 'runtime-cycle' : 'type-only-cycle'

  for (const module of output.modules) {
    for (const dependency of module.dependencies) {
      if (!dependency.circular || dependency.cycle === undefined) {
        continue
      }

      const members = canonicalCycleMembers(
        module.source,
        dependency.resolved,
        dependency,
      )
      const key = `${rule}\u0000${members.join('\u0000')}`

      if (findings.has(key)) {
        continue
      }

      findings.set(key, {
        detector: 'dependencies',
        rule,
        category: 'dependency',
        severity: cycleKind === 'runtime' ? 'high' : 'advisory',
        subject: { kind: 'cycle', members },
        summary: `${cycleKind === 'runtime' ? 'Runtime' : 'Compile-time'} dependency cycle: ${members.join(' → ')}`,
        explanation: cycleKind === 'compile-time'
          ? 'Cycles containing type-only edges couple declarations but do not exist in the emitted runtime graph.'
          : 'Runtime cycles make initialization order and module behavior harder to reason about.',
        remediation: 'Choose a dependency direction and move the shared contract or behavior behind that boundary.',
        primaryLocation: { path: members[0] ?? module.source },
        relatedLocations: members.slice(1).map((path) => ({ path })),
      })
    }
  }

  return [...findings.values()]
}

function canonicalCycleMembers(
  source: string,
  resolved: string,
  dependency: IDependency,
): readonly string[] {
  const reported = dependency.cycle?.map(({ name }) => name) ?? []
  const candidates = reported.length === 0
    ? [source, resolved]
    : reported
  const withoutClosingDuplicate = candidates.length > 1
    && candidates[0] === candidates.at(-1)
    ? candidates.slice(0, -1)
    : candidates

  return canonicalDirectedCycle(withoutClosingDuplicate)
}

function cycleIdentity(finding: Finding): string {
  return finding.subject.kind === 'cycle'
    ? finding.subject.members.join('\u0000')
    : ''
}

function fanOutFindings(output: ICruiseResult): readonly Finding[] {
  const findings: Finding[] = []

  for (const module of output.modules) {
    if (module.source.includes('node_modules')) {
      continue
    }

    const localDependencies = new Set(
      module.dependencies
        .filter((dependency) => {
          return !dependency.couldNotResolve
            && dependency.dependencyTypes.some((type) => {
              return type === 'local' || type === 'localmodule'
            })
        })
        .map(({ resolved }) => resolved),
    )
    const value = localDependencies.size
    const thresholds = FAN_OUT_THRESHOLDS[classifySourceFile(module.source)]
    if (value <= thresholds.advisory) {
      continue
    }

    const severity: FindingSeverity = value > thresholds.high
      ? 'high'
      : 'advisory'
    findings.push({
      detector: 'dependencies',
      rule: 'local-fan-out',
      category: 'dependency',
      severity,
      subject: { kind: 'file', path: module.source },
      summary: `${module.source} imports ${value} local modules`,
      explanation: 'High local fan-out means this module depends on many local modules, increasing the context needed to understand, test, and change it.',
      remediation: 'Introduce a cohesive boundary or split the module by responsibility; do not hide imports behind a barrel solely to lower the count.',
      primaryLocation: { path: module.source },
      relatedLocations: [...localDependencies]
        .sort(compareStrings)
        .map((path) => ({ path })),
      measurement: {
        value,
        unit: 'local modules',
        advisoryThreshold: thresholds.advisory,
        highThreshold: thresholds.high,
      },
    })
  }

  return findings
}

function analyzeUnresolvedImports(
  output: ICruiseResult,
): {
  readonly diagnostics: readonly AnalysisDiagnostic[]
  readonly exempted: number
} {
  const diagnostics: AnalysisDiagnostic[] = []
  let exempted = 0

  for (const module of output.modules) {
    if (module.source.includes('node_modules')) {
      continue
    }
    for (const dependency of module.dependencies) {
      if (!dependency.couldNotResolve) {
        continue
      }
      if (!isLocalSpecifier(dependency.module)) {
        continue
      }
      if (isUnresolvedImportExempted(module.source, dependency.module)) {
        exempted += 1
        continue
      }
      diagnostics.push({
        detector: 'dependencies',
        code: 'unresolved-import',
        message: `Cannot resolve ${dependency.module}`,
        location: { path: module.source },
      })
    }
  }

  return { diagnostics, exempted }
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('@/')
    || specifier.startsWith('~/')
    || specifier.startsWith('#')
}

function isUnresolvedImportExempted(
  importer: string,
  specifier: string,
): boolean {
  return UNRESOLVED_IMPORT_EXEMPTIONS.some((exemption) => {
    return exemption.importer.test(importer)
      && exemption.specifier.test(specifier)
  })
}

function compareFindings(left: Finding, right: Finding): number {
  return [left.primaryLocation.path, left.rule, JSON.stringify(left.subject)]
    .join('\u0000')
    .localeCompare(
      [right.primaryLocation.path, right.rule, JSON.stringify(right.subject)]
        .join('\u0000'),
      'en',
    )
}

function compareDiagnostics(
  left: AnalysisDiagnostic,
  right: AnalysisDiagnostic,
): number {
  return [left.location?.path ?? '', left.message]
    .join('\u0000')
    .localeCompare([right.location?.path ?? '', right.message].join('\u0000'), 'en')
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
