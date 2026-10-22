import assert from 'node:assert/strict'
import test from 'node:test'

import { STACK, finalizePlan, trainsByPackage } from './agent-stack-plan.mjs'
import { readRepoJson } from '../../../../.github/scripts/lib/release-train.mjs'

const trainsOf = trainsByPackage(
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
  finalizePlan(packages, trainsOf)
  return new Map(packages.map((p) => [p.slug, p]))
}

function changed (slug) {
  return plan(STACK.map((spec) =>
    inspected(spec, spec.slug === slug ? ['code_changes'] : [])
  ))
}

test('the engine is in the sdk train; the rest also in the cli train', () => {
  for (const spec of STACK) {
    const expected = ['inference', 'sdk'].includes(spec.slug) ? ['sdk'] : ['cli', 'sdk']
    assert.deepEqual(trainsOf.get(`@qvac/${spec.slug}`), expected, spec.slug)
  }
})

test('a changed agent-stack package releases the cli train only', () => {
  const bySlug = changed('ai-sdk-provider')

  const cli = bySlug.get('cli')
  assert.equal(cli.needsRelease, true)
  assert.equal(cli.recommendation.suggested, '0.15.1')
  assert.equal(cli.recommendation.rationale, 'Released with the cli train')
  assert.equal(
    bySlug.get('ai-sdk-provider').recommendation.rationale,
    'Outstanding non-breaking commits → patch'
  )
  assert.equal(bySlug.get('sdk').needsRelease, false)
  assert.equal(bySlug.get('inference').needsRelease, false)
})

test('a changed engine package releases the whole sdk train', () => {
  const bySlug = changed('sdk')
  for (const slug of ['inference', 'cli', 'openclaw-plugin']) {
    assert.equal(bySlug.get(slug).needsRelease, true, slug)
    assert.equal(bySlug.get(slug).train, 'sdk', slug)
  }
  assert.equal(bySlug.get('cli').recommendation.rationale, 'Released with the sdk train')
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
