import assert from 'node:assert/strict'
import test from 'node:test'

import { STACK, finalizePlan, trainsByPackage } from './agent-stack-plan.mjs'

// A whole-chain train holding a smaller one, as release-trains.json allows.
const NX_JSON = {
  release: {
    groups: {
      lower: { projects: ['@qvac/inference', '@qvac/sdk'], projectsRelationship: 'fixed' },
      upper: {
        projects: ['@qvac/cli', '@qvac/ai-sdk-provider', '@qvac/opencode-plugin', '@qvac/openclaw-plugin'],
        projectsRelationship: 'independent'
      }
    }
  }
}
const CATALOG = {
  whole: { groups: ['lower', 'upper'], anchorGroup: 'lower' },
  top: { groups: ['upper'], anchorProject: '@qvac/cli' }
}
const trainsOf = trainsByPackage(CATALOG, NX_JSON)

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

test('lists the trains of each package, smallest first', () => {
  assert.deepEqual(trainsOf.get('@qvac/sdk'), ['whole'])
  assert.deepEqual(trainsOf.get('@qvac/cli'), ['top', 'whole'])
})

test('a change only the smaller train holds releases that train alone', () => {
  const bySlug = changed('ai-sdk-provider')

  const cli = bySlug.get('cli')
  assert.equal(cli.needsRelease, true)
  assert.equal(cli.recommendation.suggested, '0.15.1')
  assert.equal(cli.recommendation.rationale, 'Released with the top train')
  assert.equal(
    bySlug.get('ai-sdk-provider').recommendation.rationale,
    'Outstanding non-breaking commits → patch'
  )
  assert.equal(bySlug.get('sdk').needsRelease, false)
  assert.equal(bySlug.get('inference').needsRelease, false)
})

test('a change outside the smaller train releases the larger one whole', () => {
  const bySlug = changed('sdk')
  for (const slug of ['inference', 'cli', 'openclaw-plugin']) {
    assert.equal(bySlug.get(slug).needsRelease, true, slug)
    assert.equal(bySlug.get(slug).train, 'whole', slug)
  }
  assert.equal(bySlug.get('cli').recommendation.rationale, 'Released with the whole train')
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
