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
// edit abort `npm run test:integration`, taking desktop CI down on every
// platform (PR #4006, reverted for vla-ggml by PR #4031).
//
// Modelled on packages/vla-ggml/scripts/lib/validate-test-groups.js. The two
// differences are llm-specific and load-bearing: coverage is pooled per OS
// family (`platformFamily`), and the benchmark shards are exempt
// (`isOverrideOnly`).

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
// top level is metadata for another consumer — a `perf_report_filter` string, or
// an object-form `deferred` — and is not a platform.
function isPlatformEntry(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A platform's OS family is its name without the optional `Weekly` suffix, so
// `iosWeekly` belongs to the `ios` family. Coverage is validated per family (the
// union of its regular + weekly splits), letting the weekend-only suite
// (.github/workflows/weekend-mobile-test-llm-llamacpp.yml, which reads the
// `iosWeekly`/`androidWeekly` maps) hold a disjoint subset of tests rather than
// duplicating the daily ones.
function platformFamily(platform) {
  return platform.replace(/Weekly$/, '')
}

// Benchmark shards (benchmark-perf-*.test.js -> runBenchmarkPerf*) and the MoE
// finetuning test are scheduled only by their own workflows via an explicit
// `test_groups` override, and are deliberately absent from test-groups.json so
// normal mobile integration runs never trigger the heavy benchmark. They are
// therefore exempt from the coverage requirement — but not from the
// "referenced runner must exist" rule, which still applies wherever a group
// does name one.
function isOverrideOnly(name) {
  return name.startsWith('runBenchmarkPerf') || name === 'runFinetuningMoeTest'
}

// The families that must be fully covered. `options.platforms` overrides
// inference; callers are expected to pin it, because inference cannot tell a
// platform that was deleted by accident from one this addon never had.
//
// Inference here folds `iosWeekly` into `ios` rather than returning it as a
// platform of its own — the top-level weekly maps are schedules, not platforms,
// and demanding full coverage of each would fail the committed file, whose
// weekly maps hold a deliberately disjoint subset.
function platformNames(groups, platforms) {
  if (platforms) {
    return [...platforms]
  }
  const inferred = Object.keys(groups)
    .filter((key) => key !== DEFERRED_KEY && isPlatformEntry(groups[key]))
    .map(platformFamily)
  return [...new Set(inferred)]
}

// Every top-level map that feeds a family's coverage: `ios` and `iosWeekly` for
// the `ios` family.
function familySources(groups, family) {
  return Object.keys(groups).filter(
    (key) => key !== DEFERRED_KEY && isPlatformEntry(groups[key]) && platformFamily(key) === family
  )
}

function coveredRunners(platformEntry) {
  return Object.values(platformEntry).filter(Array.isArray).flat()
}

// `deferred` is either a flat array — deferred on every family — or a
// `{ <family>: [runner, ...] }` map, for a runner that is scheduled on one
// family and deferred on another. The map form is why `platformNames` excludes
// DEFERRED_KEY by name rather than by shape.
function deferredRunners(groups, family) {
  const deferred = groups[DEFERRED_KEY]
  if (Array.isArray(deferred)) {
    return deferred
  }
  if (isPlatformEntry(deferred)) {
    const forFamily = deferred[family]
    return Array.isArray(forFamily) ? forFamily : []
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
// integration.auto.cjs by the caller. `options.platforms` pins the OS families
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

  const families = platformNames(groups, options.platforms)
  if (families.length === 0) {
    problems.push(
      'test-groups.json declares no platform maps.\n' +
        'Expected at least one top-level `{ "<platform>": { "<group>": [runners] } }` entry.'
    )
    return problems
  }

  // A per-family `deferred` keyed by a name that is not a family defers
  // nothing, so a typo there reads as a clean file while the runner stays
  // unassigned on the family it was meant to excuse.
  const deferredKeyed = groups[DEFERRED_KEY]
  if (isPlatformEntry(deferredKeyed)) {
    const unknownFamilies = Object.keys(deferredKeyed).filter((key) => !families.includes(key))
    if (unknownFamilies.length) {
      problems.push(
        `[${DEFERRED_KEY}] is keyed by names that are not platforms:\n  ` +
          unknownFamilies.join('\n  ') +
          `\nExpected one of: ${families.join(', ')}.`
      )
    }
  }

  // Pooling by family is what makes a misspelled top-level map dangerous: its
  // runners simply stop counting towards any required family, and the loop
  // below would blame the correctly-spelled sibling for not covering them.
  // Naming the stray key turns that confusing report into an obvious one.
  const stray = Object.keys(groups).filter(
    (key) =>
      key !== DEFERRED_KEY &&
      isPlatformEntry(groups[key]) &&
      !families.includes(platformFamily(key))
  )
  if (stray.length) {
    problems.push(
      'group maps belong to no required platform:\n  ' +
        stray.join('\n  ') +
        `\nExpected <platform> or <platform>Weekly for one of: ${families.join(', ')}.`
    )
  }

  for (const family of families) {
    const sources = familySources(groups, family)
    if (sources.length === 0) {
      problems.push(
        `[${family}] is required to be covered but test-groups.json has no ` +
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
    for (const source of sources) {
      if (Object.prototype.hasOwnProperty.call(groups[source], DEFERRED_KEY)) {
        problems.push(
          `[${source}] "${DEFERRED_KEY}" is nested inside the platform map.\n` +
            `It must be a top-level key: nested here it is scheduled as a real Device Farm shard.`
        )
      }
    }

    const covered = new Set(sources.flatMap((source) => coveredRunners(groups[source])))
    const deferredSet = new Set(deferredRunners(groups, family))

    const missing = runners.filter(
      (name) => !covered.has(name) && !deferredSet.has(name) && !isOverrideOnly(name)
    )
    if (missing.length) {
      problems.push(
        `[${family}] runners not assigned to any group:\n  ` +
          missing.join('\n  ') +
          `\nAdd them to a ${family} or ${family}Weekly group in test/mobile/test-groups.json, ` +
          `or to the top-level "${DEFERRED_KEY}" list if they are intentionally not run on device.`
      )
    }

    const extra = [...covered].filter((name) => !known.has(name))
    if (extra.length) {
      problems.push(
        `[${family}] groups reference runners that do not exist:\n  ` +
          extra.join('\n  ') +
          '\nRemove them or check for typos.'
      )
    }

    // A runner in both a shard and `deferred` is contradictory: it would run on
    // device while claiming to be deferred. Scoped per family, so the map form
    // of `deferred` can legitimately defer a runner on ios while android
    // schedules it.
    const contradictory = [...covered].filter((name) => deferredSet.has(name))
    if (contradictory.length) {
      problems.push(
        `[${family}] runners are both scheduled and listed as "${DEFERRED_KEY}":\n  ` +
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
  platformFamily,
  platformNames,
  familySources,
  isOverrideOnly,
  deferredRunners
}
