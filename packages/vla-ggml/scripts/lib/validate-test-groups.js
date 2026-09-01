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

// integration.auto.cjs declares one `async function run<Name>` per on-device
// test; once it is confirmed in sync with test/integration/, those declarations
// are the authoritative runner-name list — the same source that
// .github/actions/run-mobile-integration-tests/validate-devices greps.
//
// The extractor lives here, beside the rules that consume its output, so
// validate-mobile-tests.js and the unit tests share one implementation instead
// of each keeping its own copy of the pattern (a test asserting on its own copy
// proves nothing about the extractor that actually runs). It takes the file
// contents rather than a path to keep this module fs-free.
function generatedRunnerNames(content) {
  const declaration = /^async function (run[A-Za-z0-9_]+)\s*\(/gm
  return Array.from(content.matchAll(declaration), (m) => m[1])
}

// A platform entry is a `{ groupName: [runner, ...] }` map. Anything else at the
// top level is metadata for another consumer — OCR's `perf_report_filter`, or an
// object-form `deferred` — and is not a platform.
function isPlatformEntry(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `platforms` overrides inference. Inference is a convenience for addons whose
// only top-level maps *are* platforms, which is VLA's case; it is not safe
// everywhere. llm-llamacpp ships top-level `iosWeekly`/`androidWeekly` maps that
// are schedules rather than platforms of their own, so a caller there must pass
// the platform list explicitly or full coverage would be demanded of them too.
function platformNames(groups, platforms) {
  if (platforms) {
    return [...platforms]
  }
  return Object.keys(groups).filter((key) => key !== DEFERRED_KEY && isPlatformEntry(groups[key]))
}

function coveredRunners(platformEntry) {
  return Object.values(platformEntry).filter(Array.isArray).flat()
}

// `deferred` is either a flat array — deferred on every platform, which is what
// VLA uses — or a `{ <platform>: [runner, ...] }` map, for a runner that is
// scheduled on one platform and deferred on another. The map form is why
// `platformNames` excludes DEFERRED_KEY by name rather than by shape.
function deferredRunners(groups, platform) {
  const deferred = groups[DEFERRED_KEY]
  if (Array.isArray(deferred)) {
    return deferred
  }
  if (isPlatformEntry(deferred)) {
    const forPlatform = deferred[platform]
    return Array.isArray(forPlatform) ? forPlatform : []
  }
  return []
}

function allDeferredRunners(groups) {
  const deferred = groups[DEFERRED_KEY]
  if (Array.isArray(deferred)) {
    return deferred
  }
  if (isPlatformEntry(deferred)) {
    return Object.values(deferred).filter(Array.isArray).flat()
  }
  return []
}

// Returns a list of human-readable problem strings; empty means valid.
// `runners` is the authoritative runner-name list, derived from the generated
// integration.auto.cjs by the caller. `options.platforms` pins the platforms
// that must be covered instead of inferring them from the file's shape.
function validateTestGroups(groups, runners, options = {}) {
  const problems = []
  const known = new Set(runners)

  // A stale `deferred` entry is worse than a noisy one: it would silently
  // excuse a runner that no longer exists, and mask a real gap if the name is
  // ever reused.
  const unknownDeferred = [...new Set(allDeferredRunners(groups))].filter(
    (name) => !known.has(name)
  )
  if (unknownDeferred.length) {
    problems.push(
      `[${DEFERRED_KEY}] lists runners that do not exist:\n  ` +
        unknownDeferred.join('\n  ') +
        '\nRemove them or check for typos.'
    )
  }

  const platforms = platformNames(groups, options.platforms)
  if (platforms.length === 0) {
    problems.push(
      'test-groups.json declares no platform maps.\n' +
        'Expected at least one top-level `{ "<platform>": { "<group>": [runners] } }` entry.'
    )
    return problems
  }

  // A per-platform `deferred` keyed by a name that is not a platform defers
  // nothing, so a typo there reads as a clean file while the runner stays
  // unassigned on the platform it was meant to excuse.
  const deferredKeyed = groups[DEFERRED_KEY]
  if (isPlatformEntry(deferredKeyed)) {
    const unknownPlatforms = Object.keys(deferredKeyed).filter((key) => !platforms.includes(key))
    if (unknownPlatforms.length) {
      problems.push(
        `[${DEFERRED_KEY}] is keyed by names that are not platforms:\n  ` +
          unknownPlatforms.join('\n  ') +
          `\nExpected one of: ${platforms.join(', ')}.`
      )
    }
  }

  for (const platform of platforms) {
    const entry = groups[platform]
    if (!isPlatformEntry(entry)) {
      problems.push(
        `[${platform}] is required to be covered but test-groups.json has no ` +
          `\`{ "<group>": [runners] }\` map for it.`
      )
      continue
    }

    // `deferred` nested inside a platform is indistinguishable from a shard: to
    // `coveredRunners` below it is just another array of runner names, so the
    // whole file would validate clean — and `upload-to-devicefarm` turns every
    // `{ groupName: [runners] }` entry into a Device Farm spec, so those runners
    // would be scheduled (and billed) under a shard literally named "deferred".
    // Reserving the name here is what makes the top-level rule enforceable
    // rather than merely documented.
    if (Object.prototype.hasOwnProperty.call(entry, DEFERRED_KEY)) {
      problems.push(
        `[${platform}] "${DEFERRED_KEY}" is nested inside the platform map.\n` +
          `It must be a top-level key: nested here it is scheduled as a real Device Farm shard.`
      )
    }

    const covered = new Set(coveredRunners(entry))
    const deferredSet = new Set(deferredRunners(groups, platform))

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
    // device while claiming to be deferred. Scoped per platform, so the map form
    // of `deferred` can legitimately defer a runner on ios while android
    // schedules it.
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
  generatedRunnerNames,
  platformNames,
  deferredRunners
}
