import assert from 'node:assert/strict'
import test from 'node:test'

import { STACK, finalizePlan, trainsByPackage } from './agent-stack-plan.mjs'
import { readRepoJson } from '../../../../.github/scripts/lib/release-train.mjs'

const trainOf = trainsByPackage(
  readRepoJson('.github/release-trains.json'),
  readRepoJson('nx.json')
)

// An entry as inspectPackage leaves it, before finalizePlan.
function inspected (spec, reasons = [], blockers = []) {
  return {
    slug: spec.slug,
    npmName: `@qvac/${spec.slug}`,
    localVersion: '0.15.0',
    publishedVersion: '0.15.0',
    localPkg: {},
    reasons,
    blockers,
    outstanding: [],
    hasBreaking: false,
    needsWork: reasons.length > 0,
    needsRelease: reasons.length > 0 && blockers.length === 0
  }
}

function plan (packages) {
  finalizePlan(packages, trainOf)
  return new Map(packages.map((p) => [p.slug, p]))
}

test('every agent-stack package belongs to the sdk train', () => {
  for (const spec of STACK) assert.equal(trainOf.get(`@qvac/${spec.slug}`), 'sdk')
})

test('one changed train package gives every unchanged member a patch', () => {
  const bySlug = plan(STACK.map((spec) =>
    inspected(spec, spec.slug === 'ai-sdk-provider' ? ['code_changes'] : [])
  ))

  const cli = bySlug.get('cli')
  assert.equal(cli.needsRelease, true)
  assert.equal(cli.recommendation.suggested, '0.15.1')
  assert.equal(cli.recommendation.rationale, 'Released with the sdk train')
  assert.equal(
    bySlug.get('ai-sdk-provider').recommendation.rationale,
    'Outstanding non-breaking commits → patch'
  )
})

test('no train release when no member needs one', () => {
  const bySlug = plan(STACK.map((spec) => inspected(spec)))
  for (const p of bySlug.values()) assert.equal(p.needsRelease, false)
})

test('a blocked member stays blocked inside an active train', () => {
  const blocker = { code: 'ai_sdk_major_mismatch', message: 'hold' }
  const bySlug = plan(STACK.map((spec) => {
    if (spec.slug === 'cli') return inspected(spec, ['code_changes'])
    if (spec.slug === 'openclaw-plugin') return inspected(spec, [], [blocker])
    return inspected(spec)
  }))
  assert.equal(bySlug.get('openclaw-plugin').needsRelease, false)
  assert.equal(bySlug.get('openclaw-plugin').recommendation.kind, 'blocked')
})
