import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * The fields a registry entry must carry, and the fields a `getModel` lookup
 * must reproduce from the list it was found in. One list, used by both the
 * shape check and the agreement check, because they are the same fields.
 */
const ENTRY_FIELDS = ['name', 'registryPath', 'registrySource', 'modelId', 'addon', 'engine']

/** `modelRegistrySearch` with only the filters this test actually sets. */
const searchSteps = (filters: Record<string, string>, extra: Step[] = []): Step[] => [
  { call: { method: 'modelRegistrySearch', params: filters, as: 'models' } },
  { assert: { on: '$models', use: 'expectation' } },
  ...extra
]

export const registryListBasic: TestDefinition = {
  testId: 'registry-list-basic',
  params: { action: 'list' },
  expectation: { validation: 'type', expectedType: 'array' },
  steps: [
    { call: { method: 'modelRegistryList', as: 'models' } },
    { assert: { on: '$models', use: 'expectation' } }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registryListReturnsModels: TestDefinition = {
  testId: 'registry-list-returns-models',
  params: { action: 'list' },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  suites: ['smoke'],
  steps: [
    { call: { method: 'modelRegistryList', as: 'models' } },
    { assert: { on: '$models', use: 'expectation' } }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registryListEntryShape: TestDefinition = {
  testId: 'registry-list-entry-shape',
  params: { action: 'list', validateShape: true },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  // Two checks in a row: the list itself against the expectation, then the
  // shape of an entry. The interpreter stops at the first failing one, so the
  // second cannot mask the first.
  steps: [
    { call: { method: 'modelRegistryList', as: 'models' } },
    { assert: { on: '$models', use: 'expectation' } },
    { project: { from: '$models', path: '[0]', as: 'entry' } },
    { assert: { on: '$entry', named: 'fieldsPresent', with: { fields: ENTRY_FIELDS } } }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registrySearchNoFilters: TestDefinition = {
  testId: 'registry-search-no-filters',
  params: { action: 'search' },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  steps: searchSteps({}),
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registrySearchByEngineLlm: TestDefinition = {
  testId: 'registry-search-by-engine-llm',
  params: { action: 'search', engine: 'llamacpp-completion' },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  suites: ['smoke'],
  steps: searchSteps({ engine: '$params.engine' }),
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registrySearchByFilterWhisper: TestDefinition = {
  testId: 'registry-search-by-filter-whisper',
  params: { action: 'search', filter: 'whisper' },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  steps: searchSteps({ filter: '$params.filter' }),
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registrySearchByQuantization: TestDefinition = {
  testId: 'registry-search-by-quantization',
  params: { action: 'search', quantization: 'q4' },
  expectation: { validation: 'type', expectedType: 'array', minLength: 1 },
  steps: searchSteps({ quantization: '$params.quantization' }),
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registrySearchNoResults: TestDefinition = {
  testId: 'registry-search-no-results',
  params: { action: 'search', filter: 'nonexistent-model-xyz-12345', expectEmpty: true },
  expectation: { validation: 'type', expectedType: 'array' },
  // `expectEmpty` was a flag the executor read; as data it is the ordinary
  // length check, which is what it always meant.
  steps: searchSteps({ filter: '$params.filter' }, [
    { assert: { on: '$models', named: 'lengthIs', with: { length: 0 } } }
  ]),
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

/** Take the first list entry apart into the two keys `getModel` needs. */
const firstEntrySteps: Step[] = [
  { call: { method: 'modelRegistryList', as: 'models' } },
  { project: { from: '$models', path: '[0]', as: 'listEntry' } },
  { project: { from: '$listEntry', path: 'registryPath', as: 'registryPath' } },
  { project: { from: '$listEntry', path: 'registrySource', as: 'registrySource' } },
  {
    call: {
      method: 'modelRegistryGetModel',
      params: { registryPath: '$registryPath', registrySource: '$registrySource' },
      as: 'found'
    }
  }
]

export const registryGetModelValid: TestDefinition = {
  testId: 'registry-get-model-valid',
  params: { action: 'getModel', useFirstFromList: true },
  expectation: { validation: 'regex', pattern: '.+' },
  suites: ['smoke'],
  steps: [
    ...firstEntrySteps,
    { project: { from: '$found', path: 'name', as: 'name' } },
    { assert: { on: '$name', use: 'expectation' } }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registryGetModelNotFound: TestDefinition = {
  testId: 'registry-get-model-not-found',
  params: {
    action: 'getModel',
    registryPath: 'nonexistent/model/path.gguf',
    registrySource: 'nonexistent-source'
  },
  expectation: { validation: 'throws-error', errorContains: 'not found' },
  suites: ['smoke'],
  steps: [
    {
      callError: {
        method: 'modelRegistryGetModel',
        params: {
          registryPath: '$params.registryPath',
          registrySource: '$params.registrySource'
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registryGetModelMatchesList: TestDefinition = {
  testId: 'registry-get-model-matches-list',
  params: { action: 'getModel', useFirstFromList: true, matchList: true },
  expectation: { validation: 'regex', pattern: '.+' },
  steps: [
    ...firstEntrySteps,
    { project: { from: '$found', path: 'name', as: 'name' } },
    { assert: { on: '$name', use: 'expectation' } },
    {
      assert: {
        on: '$found',
        named: 'fieldsMatch',
        with: { expected: '$listEntry', fields: ENTRY_FIELDS }
      }
    }
  ],
  metadata: { category: 'registry', dependency: 'none', estimatedDurationMs: 5000 }
}

export const registryTests = [
  registryListBasic,
  registryListReturnsModels,
  registryListEntryShape,
  registrySearchNoFilters,
  registrySearchByEngineLlm,
  registrySearchByFilterWhisper,
  registrySearchByQuantization,
  registrySearchNoResults,
  registryGetModelValid,
  registryGetModelNotFound,
  registryGetModelMatchesList
]
