'use strict'

// Group-coverage rules for test/mobile/test-groups.json.
//
// Deliberately dependency-free and side-effect-free (no fs, no console, no
// process.exit) so the same rules run under `node` from validate-mobile-tests.js
// and are unit testable from scripts/__tests__/mobile-test-groups.test.js.
//
// This check lives OUTSIDE the generator on purpose. It answers a mobile
// scheduling question — "is every on-device runner assigned to a Device Farm
// shard?" — which has no bearing on whether integration.auto.cjs was written
// correctly. Bundling it into the generator (as generate-mobile-integration-
// tests.js used to) let a Device Farm scheduling edit abort
// `npm run test:integration` on every desktop platform: `test:integration` ->
// `test:integration:generate` -> `test:mobile:generate` runs the generator, and
// the generator threw on scheduling state *after* having already written the
// file correctly. Deleting a group to stop scheduling a test on device left its
// runner unassigned and exited 134 (SIGABRT) before a single desktop test ran.
// PR #4006 did exactly that to vla-ggml and main stayed red until PR #4031.

// Runners deliberately not scheduled on Device Farm are listed under this
// top-level key. It sits beside the platform maps rather than inside one
// because the CI composites consume only `.<platform>` and ignore every other
// top-level key (see .github/actions/run-mobile-integration-tests/
// upload-to-devicefarm/action.yml). Nesting it under `ios`/`android` would
// instead schedule it as a real shard.
const DEFERRED_KEY = 'deferred'

// Label used in problem messages for the legacy flat shape (see
// `legacyFlatGroups`), which has no platform split — its single group map is a
// coverage claim about every platform at once.
const FLAT_LABEL = 'all platforms'

// integration.auto.cjs declares one `async function run<Name>` per on-device
// test; once it is confirmed present, those declarations are the authoritative
// runner-name list — the same source that .github/actions/
// run-mobile-integration-tests/validate-devices greps.
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
// top level that is not an array is metadata for another consumer — OCR's
// `perf_report_filter` string, which test/integration/utils.js reads on device —
// and is ignored by shape rather than by name.
function isPlatformEntry(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `platforms` overrides inference. Inference is a convenience for addons whose
// only top-level maps *are* platforms, which is OCR's case; it is not safe
// everywhere. llm-llamacpp ships top-level `iosWeekly`/`androidWeekly` maps that
// are schedules rather than platforms of their own, so a caller there must pass
// the platform list explicitly or full coverage would be demanded of them too.
function platformNames(groups, platforms) {
  if (platforms) {
    return [...platforms]
  }
  return Object.keys(groups).filter((key) => key !== DEFERRED_KEY && isPlatformEntry(groups[key]))
}

// Legacy flat shape: the top level IS the `{ groupName: [runner, ...] }` map,
// with no android/ios nesting. OCR does not commit this shape — it ships the
// nested one — but the validator this module replaced accepted both, so it stays
// accepted here rather than turning an old-format file into a hard failure.
// Returns null when the file is not flat.
//
// Only reached when no platform map was found, so a nested file with an
// array-valued sibling key is still read as nested.
function legacyFlatGroups(groups) {
  const flat = Object.entries(groups).filter(
    ([key, value]) => key !== DEFERRED_KEY && Array.isArray(value)
  )
  return flat.length > 0 ? Object.fromEntries(flat) : null
}

function coveredRunners(platformEntry) {
  return Object.values(platformEntry).filter(Array.isArray).flat()
}

// `deferred` is either a flat array — deferred on every platform — or a
// `{ <platform>: [runner, ...] }` map, for a runner that is scheduled on one
// platform and deferred on another. OCR needs the map form: its two
// `android-*.test.js` files skip themselves off Android, and runDoctrWarmTest is
// an Android Mali/Vulkan warm profile. The map form is why `platformNames`
// excludes DEFERRED_KEY by name rather than by shape.
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
//
// Coverage is checked PER PLATFORM. The validator this replaced pooled every
// platform into one covered set, so a runner scheduled only on android counted
// as covered on ios too.
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
  const flat = platforms.length === 0 ? legacyFlatGroups(groups) : null

  // Each target is one coverage claim: a platform map, or the whole file in the
  // legacy flat shape.
  const targets = flat
    ? [{ label: FLAT_LABEL, entry: flat, nested: false }]
    : platforms.map((label) => ({ label, entry: groups[label], nested: true }))

  if (targets.length === 0) {
    problems.push(
      'test-groups.json declares no test groups.\n' +
        'Expected a top-level `{ "<platform>": { "<group>": [runners] } }` entry, ' +
        'or the legacy flat `{ "<group>": [runners] }` shape.'
    )
    return problems
  }

  // A per-platform `deferred` keyed by a name that is not a platform defers
  // nothing, so a typo there reads as a clean file while the runner stays
  // unassigned on the platform it was meant to excuse. Skipped for the flat
  // shape, which has no platforms to key by.
  const deferredKeyed = groups[DEFERRED_KEY]
  if (!flat && isPlatformEntry(deferredKeyed)) {
    const unknownPlatforms = Object.keys(deferredKeyed).filter((key) => !platforms.includes(key))
    if (unknownPlatforms.length) {
      problems.push(
        `[${DEFERRED_KEY}] is keyed by names that are not platforms:\n  ` +
          unknownPlatforms.join('\n  ') +
          `\nExpected one of: ${platforms.join(', ')}.`
      )
    }
  }

  for (const target of targets) {
    const { label, entry, nested } = target

    if (!isPlatformEntry(entry)) {
      problems.push(
        `[${label}] is required to be covered but test-groups.json has no ` +
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
    if (nested && Object.prototype.hasOwnProperty.call(entry, DEFERRED_KEY)) {
      problems.push(
        `[${label}] "${DEFERRED_KEY}" is nested inside the platform map.\n` +
          `It must be a top-level key: nested here it is scheduled as a real Device Farm shard.`
      )
    }

    const covered = new Set(coveredRunners(entry))
    const deferredSet = new Set(nested ? deferredRunners(groups, label) : allDeferredRunners(groups))

    const missing = runners.filter((name) => !covered.has(name) && !deferredSet.has(name))
    if (missing.length) {
      problems.push(
        `[${label}] runners not assigned to any group:\n  ` +
          missing.join('\n  ') +
          `\nAdd them to a group in test/mobile/test-groups.json, or to the ` +
          `top-level "${DEFERRED_KEY}" list if they are intentionally not run on device.`
      )
    }

    const extra = [...covered].filter((name) => !known.has(name))
    if (extra.length) {
      problems.push(
        `[${label}] groups reference runners that do not exist:\n  ` +
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
        `[${label}] runners are both scheduled and listed as "${DEFERRED_KEY}":\n  ` +
          contradictory.join('\n  ') +
          `\nRemove them from one or the other.`
      )
    }
  }

  return problems
}

module.exports = {
  DEFERRED_KEY,
  FLAT_LABEL,
  validateTestGroups,
  generatedRunnerNames,
  platformNames,
  legacyFlatGroups,
  deferredRunners
}
