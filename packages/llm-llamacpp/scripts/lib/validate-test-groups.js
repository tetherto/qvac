'use strict'

// Group coverage is kept outside the mobile generator because that generator
// also runs before desktop integration tests. Scheduling errors belong in the
// dedicated validator invoked by the unit-test gate. This module is pure and
// fs-free so the CLI and scripts/__tests__/ exercise the same rules.

const REQUIRED_PLATFORMS = ['ios', 'android']

function generatedRunnerNames(content) {
  return Array.from(
    content.matchAll(/^async function (run[A-Za-z0-9_]+)\s*\(/gm),
    (match) => match[1]
  )
}

// `iosWeekly` belongs to the `ios` family. Coverage is the union of a family's
// maps so a weekend suite can hold runners absent from the daily suite.
function platformFamily(key) {
  return key.replace(/Weekly$/, '')
}

// Benchmark shards run only through benchmark-perf-llm-llamacpp.yml's
// test_groups override. The MoE finetune test is desktop opt-in only (see
// test/integration/finetuning-moe.test.js), so neither belongs in this file.
function isOverrideOnly(name) {
  return name.startsWith('runBenchmarkPerf') || name === 'runFinetuningMoeTest'
}

function isGroupMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTestGroups(groups, runners, options = {}) {
  const problems = []
  const known = new Set(runners)
  const platforms = options.platforms?.length ? options.platforms : REQUIRED_PLATFORMS
  const maps = Object.keys(groups).filter((key) => isGroupMap(groups[key]))
  const stray = maps.filter((key) => !platforms.includes(platformFamily(key)))

  if (stray.length) {
    problems.push(
      'group maps belong to no required platform:\n  ' +
        stray.join('\n  ') +
        `\nExpected <platform> or <platform>Weekly for one of: ${platforms.join(', ')}.`
    )
  }

  for (const platform of platforms) {
    const sources = maps.filter((key) => platformFamily(key) === platform)
    if (!sources.length) {
      problems.push(
        `[${platform}] is required to be covered but test-groups.json has no ` +
          '`{ "<group>": [runners] }` map for it.'
      )
      continue
    }

    const covered = new Set(
      sources.flatMap((key) => Object.values(groups[key]).filter(Array.isArray).flat())
    )
    const missing = runners.filter((name) => !covered.has(name) && !isOverrideOnly(name))
    const extra = [...covered].filter((name) => !known.has(name))

    if (missing.length) {
      problems.push(
        `[${platform}] Tests not assigned to any group in test-groups.json:\n  ` +
          missing.join('\n  ') +
          `\nAdd them to a ${platform} or ${platform}Weekly group in test/mobile/test-groups.json.`
      )
    }
    if (extra.length) {
      problems.push(
        `[${platform}] test-groups.json references non-existent tests:\n  ` +
          extra.join('\n  ') +
          '\nRemove them or check for typos.'
      )
    }
  }

  return problems
}

module.exports = {
  REQUIRED_PLATFORMS,
  generatedRunnerNames,
  platformFamily,
  isOverrideOnly,
  validateTestGroups
}
