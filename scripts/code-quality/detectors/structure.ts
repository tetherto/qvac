import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Linter } from 'eslint'
import type { Rule } from 'eslint'
import tseslint from 'typescript-eslint'

import {
  STRUCTURE_THRESHOLDS,
  type ThresholdPair,
} from '../config.js'
import { classifySourceFile } from '../files.js'
import type {
  AnalysisDiagnostic,
  AnalysisResult,
  Finding,
  FindingCategory,
  FindingSeverity,
} from '../model.js'

export interface StructureAnalysisContext {
  readonly root: string
  readonly files: readonly string[]
}

interface FunctionScope {
  readonly startLine: number
  readonly endLine: number
  readonly symbol: string
}

interface RuleDefinition {
  readonly rule: string
  readonly eslintRule: string
  readonly category: FindingCategory
  readonly thresholds: ThresholdPair
  readonly unit: string
  readonly explanation: string
  readonly remediation: string
}

interface NodeLocation {
  readonly start: { readonly line: number }
  readonly end: { readonly line: number }
}

type SemanticNode = Rule.Node & {
  readonly id?: { readonly name?: string | undefined } | null
  readonly parent?: SemanticNode | null
  readonly callee?: SemanticNode
  readonly object?: SemanticNode
  readonly property?: SemanticNode
  readonly arguments?: readonly SemanticNode[]
  readonly key?: { readonly name?: string | undefined; readonly value?: unknown }
  readonly left?: { readonly name?: string | undefined }
  readonly name?: string | undefined
  readonly value?: unknown
}

type FunctionNode = SemanticNode & {
  readonly loc: NodeLocation
}

const MEASUREMENT_PATTERNS: Readonly<Record<string, RegExp>> = {
  'file-lines': /too many lines \((\d+)\)/,
  'function-lines': /too many lines \((\d+)\)/,
  'modified-complexity': /complexity of (\d+)/,
  'nesting-depth': /nested too deeply \((\d+)\)/,
}

export async function analyzeStructure(
  context: StructureAnalysisContext,
): Promise<AnalysisResult> {
  const findings: Finding[] = []
  const diagnostics: AnalysisDiagnostic[] = []
  const linter = new Linter()

  for (const path of [...context.files].sort(compareStrings)) {
    const source = await readFile(join(context.root, path), 'utf8')
    const scopes: FunctionScope[] = []
    const profile = classifySourceFile(path)
    const definitions = ruleDefinitions(profile)
    const messages = linter.verify(
      source,
      [createLintConfig(definitions, scopes)],
      path,
    )

    for (const message of messages) {
      if (message.fatal === true) {
        diagnostics.push({
          detector: 'structure',
          code: 'parse-error',
          message: message.message,
          location: {
            path,
            line: message.line,
            column: message.column,
          },
        })
        continue
      }

      const definition = definitions.find(({ eslintRule }) => {
        return eslintRule === message.ruleId
      })
      if (definition === undefined) {
        continue
      }
      const value = parseMeasurement(definition.rule, message.message)
      const scope = definition.rule === 'file-lines'
        ? undefined
        : findContainingScope(scopes, message.line)
      const finding = createFinding({
        definition,
        path,
        line: message.line,
        column: message.column,
        value,
        scope,
      })
      mergeFinding(findings, finding)
    }
  }

  return {
    schemaVersion: 1,
    coverage: [
      {
        detector: 'structure',
        version: Linter.version,
        filesAnalyzed: context.files.length,
      },
    ],
    findings: findings.sort(compareFindings),
    diagnostics: diagnostics.sort(compareDiagnostics),
  }
}

function createLintConfig(
  definitions: readonly RuleDefinition[],
  scopes: FunctionScope[],
): Linter.Config {
  const rules: Record<string, Linter.RuleEntry> = {
    'quality/collect-functions': 'warn',
  }

  for (const definition of definitions) {
    rules[definition.eslintRule] = [
      'warn',
      eslintRuleOptions(definition),
    ]
  }

  return {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      quality: {
        rules: {
          'collect-functions': createFunctionCollector(scopes),
        },
      },
    },
    rules,
  }
}

function eslintRuleOptions(definition: RuleDefinition): object {
  if (definition.rule === 'modified-complexity') {
    return { max: definition.thresholds.advisory, variant: 'modified' }
  }
  if (definition.rule === 'file-lines') {
    return {
      max: definition.thresholds.advisory,
      skipBlankLines: true,
      skipComments: true,
    }
  }
  if (definition.rule === 'function-lines') {
    return {
      max: definition.thresholds.advisory,
      skipBlankLines: true,
      skipComments: true,
      IIFEs: true,
    }
  }
  return { max: definition.thresholds.advisory }
}

function createFunctionCollector(scopes: FunctionScope[]): Rule.RuleModule {
  const ordinals = new Map<string, number>()
  const scopeStack: string[] = []

  function collect(node: Rule.Node): void {
    const functionNode = node as FunctionNode
    const baseName = functionBaseName(functionNode)
    const scopedBaseName = scopeStack.length === 0
      ? baseName
      : `${scopeStack.at(-1)} > ${baseName}`
    const ordinal = (ordinals.get(scopedBaseName) ?? 0) + 1
    ordinals.set(scopedBaseName, ordinal)
    const symbol = `${scopedBaseName}#${ordinal}`
    scopes.push({
      startLine: functionNode.loc.start.line,
      endLine: functionNode.loc.end.line,
      symbol,
    })
    scopeStack.push(symbol)
  }

  function leave(): void {
    scopeStack.pop()
  }

  return {
    meta: {
      type: 'problem',
      schema: [],
    },
    create: () => ({
      ArrowFunctionExpression: collect,
      'ArrowFunctionExpression:exit': leave,
      FunctionDeclaration: collect,
      'FunctionDeclaration:exit': leave,
      FunctionExpression: collect,
      'FunctionExpression:exit': leave,
    }),
  }
}

function functionBaseName(node: FunctionNode): string {
  if (node.id?.name !== undefined) {
    return node.id.name
  }

  const parent = node.parent
  if (parent?.type === 'VariableDeclarator' && parent.id?.name !== undefined) {
    return parent.id.name
  }
  if (
    (parent?.type === 'MethodDefinition' || parent?.type === 'Property')
    && parent.key !== undefined
  ) {
    const memberName = parent.key.name
      ?? (typeof parent.key.value === 'string' ? parent.key.value : undefined)
    if (memberName !== undefined) {
      const owner = nearestOwnerName(parent.parent)
      return owner === undefined ? memberName : `${owner} > ${memberName}`
    }
  }
  if (parent?.type === 'CallExpression' && parent.callee !== undefined) {
    const callee = parent.callee as SemanticNode
    const calleeName = callee.name
      ?? callee.property?.name
      ?? (
        typeof callee.property?.value === 'string'
          ? callee.property.value
          : undefined
    )
    if (calleeName !== undefined) {
      const label = (parent as SemanticNode).arguments
        ?.find((argument) => argument !== node && typeof argument.value === 'string')
        ?.value
      const callbackName = typeof label === 'string'
        ? `${calleeName} ${JSON.stringify(label)} callback`
        : `${calleeName} callback`
      const owner = nearestOwnerName(parent.parent)
        ?? memberReceiverName(callee)
      return owner === undefined
        ? callbackName
        : `${owner} > ${callbackName}`
    }
  }

  return '<anonymous>'
}

function nearestOwnerName(
  node: SemanticNode | null | undefined,
): string | undefined {
  let current = node

  while (current != null) {
    if (
      (current.type === 'ClassDeclaration' || current.type === 'ClassExpression')
      && current.id?.name !== undefined
    ) {
      return current.id.name
    }
    if (current.type === 'VariableDeclarator' && current.id?.name !== undefined) {
      return current.id.name
    }
    if (
      (current.type === 'Property' || current.type === 'MethodDefinition')
      && current.key !== undefined
    ) {
      if (current.key.name !== undefined) {
        return current.key.name
      }
      if (typeof current.key.value === 'string') {
        return current.key.value
      }
    }
    if (current.type === 'AssignmentExpression' && current.left?.name !== undefined) {
      return current.left.name
    }
    if (
      current.type === 'ArrowFunctionExpression'
      || current.type === 'FunctionDeclaration'
      || current.type === 'FunctionExpression'
    ) {
      return undefined
    }
    current = current.parent
  }

  return undefined
}

function memberReceiverName(node: SemanticNode): string | undefined {
  if (node.type !== 'MemberExpression') {
    return undefined
  }
  return expressionName(node.object)
}

function expressionName(node: SemanticNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined
  }
  if (node.type === 'Identifier') {
    return node.name
  }
  if (node.type === 'ThisExpression') {
    return 'this'
  }
  if (node.type !== 'MemberExpression') {
    return undefined
  }

  const owner = expressionName(node.object)
  const member = node.property?.name
    ?? (typeof node.property?.value === 'string' ? node.property.value : undefined)
  return owner === undefined || member === undefined
    ? undefined
    : `${owner}.${member}`
}

function ruleDefinitions(
  profile: keyof typeof STRUCTURE_THRESHOLDS,
): readonly RuleDefinition[] {
  const thresholds = STRUCTURE_THRESHOLDS[profile]

  return [
    {
      rule: 'file-lines',
      eslintRule: 'max-lines',
      category: 'size',
      thresholds: thresholds.fileLines,
      unit: 'code lines',
      explanation: 'Large files tend to combine responsibilities and increase navigation and review cost.',
      remediation: 'Split the file along cohesive responsibilities while preserving its public contract.',
    },
    {
      rule: 'function-lines',
      eslintRule: 'max-lines-per-function',
      category: 'size',
      thresholds: thresholds.functionLines,
      unit: 'code lines',
      explanation: 'Long functions require more context to understand and make focused testing harder.',
      remediation: 'Extract named steps or separate responsibilities without obscuring control flow.',
    },
    {
      rule: 'modified-complexity',
      eslintRule: 'complexity',
      category: 'complexity',
      thresholds: thresholds.modifiedComplexity,
      unit: 'branches',
      explanation: 'High branching complexity increases the number of paths that must be understood and tested.',
      remediation: 'Simplify conditions or extract independently testable decisions.',
    },
    {
      rule: 'nesting-depth',
      eslintRule: 'max-depth',
      category: 'nesting',
      thresholds: thresholds.nestingDepth,
      unit: 'levels',
      explanation: 'Deep nesting hides the main path and makes control-flow changes risky.',
      remediation: 'Use guard clauses or extract nested branches into named functions.',
    },
  ]
}

function parseMeasurement(rule: string, message: string): number {
  const match = MEASUREMENT_PATTERNS[rule]?.exec(message)
  const value = match?.[1]

  if (value === undefined) {
    throw new Error(`Could not parse ${rule} measurement from ESLint: ${message}`)
  }
  return Number(value)
}

function findContainingScope(
  scopes: readonly FunctionScope[],
  line: number,
): FunctionScope | undefined {
  return scopes
    .filter(({ startLine, endLine }) => startLine <= line && line <= endLine)
    .sort((left, right) => {
      return (left.endLine - left.startLine) - (right.endLine - right.startLine)
    })
    .at(0)
}

function createFinding(input: {
  readonly definition: RuleDefinition
  readonly path: string
  readonly line: number
  readonly column: number
  readonly value: number
  readonly scope: FunctionScope | undefined
}): Finding {
  const { definition, path, line, column, value, scope } = input
  const severity: FindingSeverity = value > definition.thresholds.high
    ? 'high'
    : 'advisory'
  const subject = scope === undefined
    ? { kind: 'file' as const, path }
    : { kind: 'function' as const, path, symbol: scope.symbol }
  const subjectLabel = scope === undefined ? path : `${scope.symbol} in ${path}`

  return {
    detector: 'structure',
    rule: definition.rule,
    category: definition.category,
    severity,
    subject,
    summary: `${subjectLabel} exceeds the ${definition.rule} threshold`,
    explanation: definition.explanation,
    remediation: definition.remediation,
    primaryLocation: { path, line, column },
    relatedLocations: [],
    measurement: {
      value,
      unit: definition.unit,
      advisoryThreshold: definition.thresholds.advisory,
      highThreshold: definition.thresholds.high,
    },
  }
}

function mergeFinding(findings: Finding[], candidate: Finding): void {
  const index = findings.findIndex((finding) => {
    return finding.detector === candidate.detector
      && finding.rule === candidate.rule
      && JSON.stringify(finding.subject) === JSON.stringify(candidate.subject)
  })

  if (index === -1) {
    findings.push(candidate)
    return
  }

  const existingValue = findings[index]?.measurement?.value ?? 0
  const candidateValue = candidate.measurement?.value ?? 0
  if (candidateValue > existingValue) {
    findings[index] = candidate
  }
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
  return [left.location?.path ?? '', left.location?.line ?? 0, left.message]
    .join('\u0000')
    .localeCompare(
      [right.location?.path ?? '', right.location?.line ?? 0, right.message]
        .join('\u0000'),
      'en',
    )
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
