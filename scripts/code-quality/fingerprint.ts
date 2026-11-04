import { createHash } from 'node:crypto'

import type { Finding, FindingSubject } from './model.js'

export function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')

  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Expected a repository-relative path, received: ${path}`)
  }

  return normalized
}

export function canonicalDirectedCycle(
  members: readonly string[],
): readonly string[] {
  if (members.length === 0) {
    throw new Error('A cycle must contain at least one member')
  }

  const normalized = members.map(normalizeRepositoryPath)
  const rotations = normalized.map((_, index) => [
    ...normalized.slice(index),
    ...normalized.slice(0, index),
  ])

  return rotations.reduce((smallest, candidate) => {
    return compareStringArrays(candidate, smallest) < 0 ? candidate : smallest
  })
}

export function fingerprintFinding(finding: Finding): string {
  const identity = {
    detector: finding.detector,
    rule: finding.rule,
    subject: normalizeSubject(finding.subject),
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')

  return `quality-v1:${digest}`
}

function normalizeSubject(subject: FindingSubject): FindingSubject {
  switch (subject.kind) {
    case 'file':
      return {
        kind: 'file',
        path: normalizeRepositoryPath(subject.path),
      }
    case 'function':
      return {
        kind: 'function',
        path: normalizeRepositoryPath(subject.path),
        symbol: subject.symbol,
      }
    case 'cycle':
      return {
        kind: 'cycle',
        members: canonicalDirectedCycle(subject.members),
      }
  }
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  return left.join('\u0000').localeCompare(right.join('\u0000'), 'en')
}
