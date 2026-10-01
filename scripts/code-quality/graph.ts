import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { stableErrorMessage } from './diagnostics.js'
import { canonicalDirectedCycle } from './fingerprint.js'
import type {
  AnalysisDiagnostic,
  AnalysisResult,
  Finding,
} from './model.js'

interface WorkspacePackage {
  readonly name: string
  readonly directory: string
  readonly dependencies: readonly string[]
}

export async function analyzeWorkspaceCycles(root: string): Promise<AnalysisResult> {
  const diagnostics: AnalysisDiagnostic[] = []
  const packages = await readWorkspacePackages(root, diagnostics)
  const workspaceNames = new Set(packages.map(({ name }) => name))
  const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const graph = new Map(
    packages.map((pkg) => [
      pkg.name,
      pkg.dependencies
        .filter((dependency) => workspaceNames.has(dependency))
        .sort(compareStrings),
    ]),
  )
  const findings = findDirectedCycles(graph).map((members): Finding => {
    const firstPackage = packageByName.get(members[0] ?? '')
    const locations = members.map((name) => {
      const directory = packageByName.get(name)?.directory ?? name
      return { path: `${directory}/package.json` }
    })

    return {
      detector: 'workspace-graph',
      rule: 'package-cycle',
      category: 'workspace-dependency',
      severity: 'high',
      subject: { kind: 'cycle', members },
      summary: `Workspace package cycle: ${members.join(' → ')}`,
      explanation: 'Package cycles erase ownership direction and force packages to evolve together.',
      remediation: 'Choose a dependency direction and move the shared contract into an existing lower-level package or a deliberately owned new package.',
      primaryLocation: {
        path: `${firstPackage?.directory ?? members[0] ?? 'package.json'}/package.json`,
      },
      relatedLocations: locations.slice(1),
    }
  })

  return {
    schemaVersion: 1,
    coverage: [
      {
        detector: 'workspace-graph',
        version: '1',
        workspacesAnalyzed: packages.length,
      },
    ],
    findings,
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

async function readWorkspacePackages(
  root: string,
  diagnostics: AnalysisDiagnostic[],
): Promise<readonly WorkspacePackage[]> {
  const workspaceFile = 'pnpm-workspace.yaml'
  let source: string

  try {
    source = await readFile(join(root, workspaceFile), 'utf8')
  } catch (error) {
    diagnostics.push({
      detector: 'workspace-graph',
      code: 'workspace-config-error',
      message: stableErrorMessage(error, root),
      location: { path: workspaceFile },
    })
    return []
  }

  const patterns = readWorkspacePatterns(source)
  const directories = new Set<string>()

  for (const pattern of patterns) {
    for (const directory of await expandWorkspacePattern(root, pattern, diagnostics)) {
      directories.add(directory)
    }
  }

  const packages: WorkspacePackage[] = []
  for (const directory of [...directories].sort(compareStrings)) {
    const manifestPath = `${directory}/package.json`
    try {
      const manifestSource = await readFile(join(root, manifestPath), 'utf8')
      const manifest: unknown = JSON.parse(manifestSource)
      const parsed = parseManifest(manifest, directory)
      packages.push(parsed)
    } catch (error) {
      if (isMissingFile(error)) {
        continue
      }
      diagnostics.push({
        detector: 'workspace-graph',
        code: 'package-manifest-error',
        message: stableErrorMessage(error, root),
        location: { path: manifestPath },
      })
    }
  }

  return packages.sort((left, right) => compareStrings(left.name, right.name))
}

function readWorkspacePatterns(source: string): readonly string[] {
  const lines = source.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => /^packages:\s*$/.test(line))
  if (sectionStart === -1) {
    return []
  }

  const patterns: string[] = []
  for (const line of lines.slice(sectionStart + 1)) {
    if (line.trim() === '') {
      continue
    }
    if (!/^\s/.test(line)) {
      break
    }
    const match = /^\s+-\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (match?.[1] !== undefined) {
      patterns.push(match[1])
    }
  }
  return patterns
}

async function expandWorkspacePattern(
  root: string,
  pattern: string,
  diagnostics: AnalysisDiagnostic[],
): Promise<readonly string[]> {
  if (!pattern.includes('*')) {
    return [pattern.replace(/\/$/, '')]
  }
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    diagnostics.push({
      detector: 'workspace-graph',
      code: 'unsupported-workspace-pattern',
      message: `Unsupported workspace pattern: ${pattern}`,
      location: { path: 'pnpm-workspace.yaml' },
    })
    return []
  }

  const parent = pattern.slice(0, -2)
  try {
    const entries = await readdir(join(root, parent), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .sort(compareStrings)
  } catch (error) {
    diagnostics.push({
      detector: 'workspace-graph',
      code: 'workspace-pattern-error',
      message: stableErrorMessage(error, root),
      location: { path: parent },
    })
    return []
  }
}

function parseManifest(value: unknown, directory: string): WorkspacePackage {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new Error(`Workspace ${directory} has no package name`)
  }

  const dependencyFields = [
    value.dependencies,
    value.devDependencies,
    value.optionalDependencies,
    value.peerDependencies,
  ]
  const dependencies = new Set<string>()
  for (const field of dependencyFields) {
    if (field === undefined) {
      continue
    }
    if (!isRecord(field)) {
      throw new Error(`Workspace ${directory} has a malformed dependency field`)
    }
    for (const dependency of Object.keys(field)) {
      dependencies.add(dependency)
    }
  }

  return {
    name: value.name,
    directory,
    dependencies: [...dependencies].sort(compareStrings),
  }
}

function findDirectedCycles(
  graph: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const cycles = new Map<string, readonly string[]>()
  const nodes = [...graph.keys()].sort(compareStrings)

  for (const start of nodes) {
    visitCycle(start, start, [start], new Set([start]), graph, cycles)
  }

  return [...cycles.values()].sort((left, right) => {
    return compareStrings(left.join('\u0000'), right.join('\u0000'))
  })
}

function visitCycle(
  start: string,
  current: string,
  path: readonly string[],
  visited: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly string[]>,
  cycles: Map<string, readonly string[]>,
): void {
  for (const next of graph.get(current) ?? []) {
    if (next === start) {
      const canonical = canonicalDirectedCycle(path)
      cycles.set(canonical.join('\u0000'), canonical)
      continue
    }
    if (visited.has(next) || compareStrings(next, start) < 0) {
      continue
    }

    visitCycle(
      start,
      next,
      [...path, next],
      new Set([...visited, next]),
      graph,
      cycles,
    )
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
}

function compareDiagnostics(
  left: AnalysisDiagnostic,
  right: AnalysisDiagnostic,
): number {
  return [left.location?.path ?? '', left.code, left.message]
    .join('\u0000')
    .localeCompare(
      [right.location?.path ?? '', right.code, right.message].join('\u0000'),
      'en',
    )
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
