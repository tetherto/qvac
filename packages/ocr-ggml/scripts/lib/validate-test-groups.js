'use strict'

// Group coverage is kept outside the mobile generator because that generator
// also runs before desktop integration tests. Bundling the check there once let
// a scheduling edit abort `npm run test:integration` on every desktop
// platform (PR #4006). This module is fs-free so the CLI and unit tests enforce
// the same scheduling rules.

const REQUIRED_PLATFORMS = ['android', 'ios']
// .github/actions/run-mobile-integration-tests/upload-to-devicefarm/action.yml
// reads only `.<platform>` from test-groups.json. Keep deferred at the top
// level because nesting it under a platform would schedule a real shard.
const DEFERRED_KEY = 'deferred'
const FLAT_LABEL = 'all platforms'

function generatedRunnerNames(content) {
  return Array.from(content.matchAll(/^async function (run[A-Za-z0-9_]+)\s*\(/gm), (match) => match[1])
}

function isGroupMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function platformMaps(groups) {
  return Object.keys(groups).filter(
    (key) => key !== DEFERRED_KEY && isGroupMap(groups[key])
  )
}

function legacyFlatGroups(groups) {
  // Retained only because the previous validator accepted this shape. The
  // committed manifest uses nested android and ios maps.
  const entries = Object.entries(groups).filter(
    ([key, value]) => key !== DEFERRED_KEY && Array.isArray(value)
  )
  return entries.length ? Object.fromEntries(entries) : null
}

function deferredRunners(groups, platform) {
  // The map form lets a runner be scheduled on one platform and deferred on
  // another, as required by OCR's Android-only backend tests.
  const deferred = groups[DEFERRED_KEY]
  if (Array.isArray(deferred)) return deferred
  if (!isGroupMap(deferred)) return []
  return Array.isArray(deferred[platform]) ? deferred[platform] : []
}

function allDeferredRunners(groups) {
  const deferred = groups[DEFERRED_KEY]
  if (Array.isArray(deferred)) return deferred
  if (!isGroupMap(deferred)) return []
  return Object.values(deferred).filter(Array.isArray).flat()
}

function coveredRunners(groups) {
  return Object.values(groups).filter(Array.isArray).flat()
}

function checkCoverage(problems, label, groups, deferred, runners, known, nested) {
  // To coveredRunners, nested deferred is just another runner array, so the
  // file would validate clean while upload-to-devicefarm schedules and bills a
  // real shard literally named "deferred".
  if (nested && Object.prototype.hasOwnProperty.call(groups, DEFERRED_KEY)) {
    problems.push(
      `[${label}] "${DEFERRED_KEY}" is nested inside the platform map.\n` +
        'It must be a top-level key: nested here it is scheduled as a real Device Farm shard.'
    )
  }

  const covered = new Set(coveredRunners(groups))
  const missing = runners.filter((name) => !covered.has(name) && !deferred.has(name))
  const extra = [...covered].filter((name) => !known.has(name))
  const contradictory = [...covered].filter((name) => deferred.has(name))

  if (missing.length) {
    const hint = nested
      ? `Add them to a ${label} group in test/mobile/test-groups.json, or to the top-level "${DEFERRED_KEY}" map if they are intentionally not run on that platform.`
      : `Add them to a group in test/mobile/test-groups.json, or to the top-level "${DEFERRED_KEY}" list.`
    problems.push(
      `[${label}] Tests not assigned to any group in test-groups.json:\n  ` +
        missing.join('\n  ') +
        `\n${hint}`
    )
  }
  if (extra.length) {
    problems.push(
      `[${label}] test-groups.json references non-existent tests:\n  ` +
        extra.join('\n  ') +
        '\nRemove them or check for typos.'
    )
  }
  if (contradictory.length) {
    problems.push(
      `[${label}] runners are both scheduled and listed as "${DEFERRED_KEY}":\n  ` +
        contradictory.join('\n  ') +
        '\nRemove them from one or the other.'
    )
  }
}

function validateTestGroups(groups, runners, options = {}) {
  const problems = []
  const known = new Set(runners)
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

  const nested = platformMaps(groups).length > 0
  const flat = nested ? null : legacyFlatGroups(groups)
  if (!nested && !flat) {
    problems.push('test-groups.json declares no test groups.')
    return problems
  }

  if (flat) {
    checkCoverage(
      problems,
      FLAT_LABEL,
      flat,
      new Set(allDeferredRunners(groups)),
      runners,
      known,
      false
    )
    return problems
  }

  // Pin defaults so deleting a platform map fails in the CLI, not only in a
  // unit test. Treat an empty override as the required default list as well.
  const platforms = options.platforms?.length ? options.platforms : REQUIRED_PLATFORMS
  const unknownMaps = platformMaps(groups).filter((key) => !platforms.includes(key))
  if (unknownMaps.length) {
    problems.push(
      'test-groups.json has top-level maps that are not platforms:\n  ' +
        unknownMaps.join('\n  ') +
        `\nExpected one of: ${platforms.join(', ')}.`
    )
  }

  const deferred = groups[DEFERRED_KEY]
  if (isGroupMap(deferred)) {
    const unknownPlatforms = Object.keys(deferred).filter((key) => !platforms.includes(key))
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
    if (!isGroupMap(entry)) {
      problems.push(
        `[${platform}] is required to be covered but test-groups.json has no ` +
          '`{ "<group>": [runners] }` map for it.'
      )
      continue
    }
    checkCoverage(
      problems,
      platform,
      entry,
      new Set(deferredRunners(groups, platform)),
      runners,
      known,
      true
    )
  }

  return problems
}

module.exports = {
  REQUIRED_PLATFORMS,
  FLAT_LABEL,
  generatedRunnerNames,
  legacyFlatGroups,
  validateTestGroups
}
