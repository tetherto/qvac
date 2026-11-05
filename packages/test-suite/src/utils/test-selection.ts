import type { TestDefinition } from '../types/test-definition.js'
import { getPlatformSkipReason, isSkippedEverywhere } from './platform-match.js'

export interface SelectionOptions {
  /** Include only tests tagged with one of these suites */
  suite?: string
  /** Drop tests tagged with one of these suites */
  excludeSuite?: string
  /** Keep tests whose testId starts with, or whose category equals, one of these */
  filter?: string
  /** Exact testIds to run in addition to the selection above */
  include?: string
}

export interface Selection {
  tests: TestDefinition[]
  /** True when any option narrowed the catalog */
  filtered: boolean
  /** Ids from `include` that the suite/filter selection had excluded */
  addedTestIds: string[]
  /** Ids in `include` that match no test in the catalog */
  unknownTestIds: string[]
}

function parseList(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * Resolve which tests a run should execute.
 *
 * `suite`, `excludeSuite` and `filter` compose with AND — each narrows what the
 * previous one left. `include` instead unions exact testIds back in, which is what
 * makes "the smoke suite plus the tests this PR touched" expressible; the
 * AND-composing options cannot express it.
 */
export function selectTests(
  catalog: readonly TestDefinition[],
  options: SelectionOptions
): Selection {
  let tests: readonly TestDefinition[] = catalog
  let filtered = false

  if (options.suite) {
    const suites = parseList(options.suite)
    tests = tests.filter((test) => test.suites?.some((suite) => suites.includes(suite)))
    filtered = true
  }

  if (options.excludeSuite) {
    const excluded = parseList(options.excludeSuite)
    tests = tests.filter((test) => !test.suites?.some((suite) => excluded.includes(suite)))
    filtered = true
  }

  if (options.filter) {
    const filters = parseList(options.filter)
    tests = tests.filter((test) =>
      filters.some((filter) => test.testId.startsWith(filter) || test.metadata?.category === filter)
    )
    filtered = true
  }

  const addedTestIds: string[] = []
  const unknownTestIds: string[] = []

  if (options.include) {
    const requested = new Set(parseList(options.include))
    const catalogIds = new Set(catalog.map((test) => test.testId))
    const selectedIds = new Set(tests.map((test) => test.testId))

    for (const id of requested) {
      if (!catalogIds.has(id)) {
        unknownTestIds.push(id)
      } else if (!selectedIds.has(id)) {
        addedTestIds.push(id)
      }
    }

    if (addedTestIds.length > 0) {
      const keep = new Set([...selectedIds, ...addedTestIds])
      // Rebuild from the catalog so queue order stays independent of option order.
      tests = catalog.filter((test) => keep.has(test.testId))
    }
  }

  return { tests: [...tests], filtered, addedTestIds, unknownTestIds }
}

export interface RunSelectionOptions extends SelectionOptions {
  /** The label a consumer registers with (e.g. `desktop-macos`); drops tests it skips */
  platform: string
}

export interface RunSelection extends Selection {
  /** Ids the selection kept but platform policy skips on `platform` */
  platformSkippedTestIds: string[]
}

/**
 * The tests one consumer leg executes: `selectTests` minus the tests the producer skips everywhere
 * (it never queues them) and the tests the leg skips on its platform, as a consumer narrows
 * `filteredTestIds` before it bootstraps.
 */
export function selectRunTests(
  catalog: readonly TestDefinition[],
  options: RunSelectionOptions
): RunSelection {
  const selection = selectTests(catalog, options)
  const tests: TestDefinition[] = []
  const platformSkippedTestIds: string[] = []
  for (const test of selection.tests) {
    if (isSkippedEverywhere(test)) continue
    if (getPlatformSkipReason(test, options.platform) === null) tests.push(test)
    else platformSkippedTestIds.push(test.testId)
  }
  return { ...selection, tests, platformSkippedTestIds }
}
