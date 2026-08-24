'use strict'

// Group-coverage rules for test/mobile/test-groups.json.
//
// Deliberately dependency-free and side-effect-free (no fs, no process.exit) so
// the same rules run under `node` from validate-mobile-tests.js and are unit
// testable from scripts/__tests__/mobile-test-groups.test.js.
//
// This check lives OUTSIDE the generator on purpose. It answers a mobile
// scheduling question — "is every on-device runner assigned to a Device Farm
// shard?" — which has no bearing on whether integration.auto.cjs was written
// correctly. Bundling it into the generator once let a Device Farm scheduling
// edit abort `npm run test:integration`, taking desktop CI down on all seven
// platforms (PR #4006).

// Runners deliberately not scheduled on Device Farm are listed under this
// top-level key. It sits beside the platform maps rather than inside one
// because the CI composites consume only `.<platform>` and ignore every other
// top-level key (see .github/actions/run-mobile-integration-tests/
// upload-to-devicefarm/action.yml). Nesting it under `ios`/`android` would
// instead schedule it as a real shard.
const DEFERRED_KEY = 'deferred'

// A platform entry is a `{ groupName: [runner, ...] }` map. Anything else at the
// top level is metadata for another consumer — `deferred` here, OCR's
// `perf_report_filter` — and is not a platform.
function isPlatformEntry(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function platformNames(groups) {
  return Object.keys(groups).filter((key) => isPlatformEntry(groups[key]))
}

function coveredRunners(platformEntry) {
  return Object.values(platformEntry).filter(Array.isArray).flat()
}

function deferredRunners(groups) {
  const deferred = groups[DEFERRED_KEY]
  return Array.isArray(deferred) ? deferred : []
}

// Returns a list of human-readable problem strings; empty means valid.
// `runners` is the authoritative runner-name list, derived from the generated
// integration.auto.cjs by the caller.
function validateTestGroups(groups, runners) {
  const problems = []
  const known = new Set(runners)
  const deferred = deferredRunners(groups)

  // A stale `deferred` entry is worse than a noisy one: it would silently
  // excuse a runner that no longer exists, and mask a real gap if the name is
  // ever reused.
  const unknownDeferred = deferred.filter((name) => !known.has(name))
  if (unknownDeferred.length) {
    problems.push(
      `[${DEFERRED_KEY}] lists runners that do not exist:\n  ` +
        unknownDeferred.join('\n  ') +
        '\nRemove them or check for typos.'
    )
  }

  const platforms = platformNames(groups)
  if (platforms.length === 0) {
    problems.push(
      'test-groups.json declares no platform maps.\n' +
        'Expected at least one top-level `{ "<platform>": { "<group>": [runners] } }` entry.'
    )
    return problems
  }

  const deferredSet = new Set(deferred)

  for (const platform of platforms) {
    // `deferred` nested inside a platform is indistinguishable from a shard: to
    // `coveredRunners` below it is just another array of runner names, so the
    // whole file would validate clean — and `upload-to-devicefarm` turns every
    // `{ groupName: [runners] }` entry into a Device Farm spec, so those runners
    // would be scheduled (and billed) under a shard literally named "deferred".
    // Reserving the name here is what makes the top-level rule enforceable
    // rather than merely documented.
    if (Object.prototype.hasOwnProperty.call(groups[platform], DEFERRED_KEY)) {
      problems.push(
        `[${platform}] "${DEFERRED_KEY}" is nested inside the platform map.\n` +
          `It must be a top-level key: nested here it is scheduled as a real Device Farm shard.`
      )
    }

    const covered = new Set(coveredRunners(groups[platform]))

    const missing = runners.filter((name) => !covered.has(name) && !deferredSet.has(name))
    if (missing.length) {
      problems.push(
        `[${platform}] runners not assigned to any group:\n  ` +
          missing.join('\n  ') +
          `\nAdd them to a group in test/mobile/test-groups.json, or to the ` +
          `top-level "${DEFERRED_KEY}" list if they are intentionally not run on device.`
      )
    }

    const extra = [...covered].filter((name) => !known.has(name))
    if (extra.length) {
      problems.push(
        `[${platform}] groups reference runners that do not exist:\n  ` +
          extra.join('\n  ') +
          '\nRemove them or check for typos.'
      )
    }

    // A runner in both a shard and `deferred` is contradictory: it would run on
    // device while claiming to be deferred.
    const contradictory = [...covered].filter((name) => deferredSet.has(name))
    if (contradictory.length) {
      problems.push(
        `[${platform}] runners are both scheduled and listed as "${DEFERRED_KEY}":\n  ` +
          contradictory.join('\n  ') +
          `\nRemove them from one or the other.`
      )
    }
  }

  return problems
}

module.exports = {
  DEFERRED_KEY,
  validateTestGroups,
  platformNames,
  deferredRunners
}
