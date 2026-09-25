import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * The refusal these tests expect while suspended.
 *
 * The numeric code, not the error name: the name is a JS-side field, while
 * every client carries the code, so pinning the code is what makes the same
 * body answerable in another language.
 */
const LIFECYCLE_OPERATION_BLOCKED = 53602

/** Reads the runtime state and checks it is the one this point expects. */
const expectState = (expected: 'active' | 'suspended'): Step[] => [
  { call: { method: 'state', as: 'lifecycle' } },
  { project: { from: '$lifecycle', path: 'state', as: 'stateValue' } },
  { assert: { on: '$stateValue', named: 'valueIn', with: { values: [expected] } } }
]

/**
 * Every lifecycle test leaves the runtime active, whether it passed or not.
 *
 * A body that fails while suspended would otherwise poison every test after
 * it: completion and registry calls are blocked in that state, so one failure
 * becomes a whole run of them. The imperative executor did this in a `finally`
 * and appended "recovery also failed" to the diagnosis; teardown steps are the
 * declarative form of the same guarantee.
 */
const restoreActive: Step[] = [{ call: { method: 'resume' } }, ...expectState('active')]

/** The completion these tests use to establish that inference still works. */
const askAndExpectText = (question: string, as: string): Step[] => [
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: { modelId: '$model', history: [{ role: 'user', content: question }], stream: false },
      as
    }
  },
  { project: { from: `$${as}`, path: 'text', as: `${as}Text` } },
  { assert: { on: `$${as}Text`, named: 'nonEmptyText' } }
]

const createLifecycleTest = (
  testId: string,
  steps: Step[],
  dependency: string = 'none',
  estimatedDurationMs: number = 30000,
  suites?: string[]
): TestDefinition => ({
  testId,
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  ...(suites && { suites }),
  steps,
  finally: restoreActive,
  metadata: { category: 'lifecycle', dependency, estimatedDurationMs }
})

export const lifecycleSuspendResumeBasic = createLifecycleTest(
  'lifecycle-suspend-resume-basic',
  [
    { call: { method: 'suspend' } },
    ...expectState('suspended'),
    { call: { method: 'resume' } },
    ...expectState('active'),
    { call: { method: 'modelRegistryList', as: 'models' } },
    { assert: { on: '$models', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  'none',
  30000,
  ['smoke']
)
export const lifecycleSuspendIdempotent = createLifecycleTest(
  'lifecycle-suspend-idempotent',
  [{ call: { method: 'suspend' } }, { call: { method: 'suspend' } }, ...expectState('suspended')],
  'none',
  30000,
  ['smoke']
)
export const lifecycleResumeIdempotent = createLifecycleTest('lifecycle-resume-idempotent', [
  { call: { method: 'resume' } },
  { call: { method: 'resume' } },
  ...expectState('active')
])
export const lifecycleSuspendResumeInference = createLifecycleTest(
  'lifecycle-suspend-resume-inference',
  [
    { useModel: { deps: ['llm'], as: 'model' } },
    ...askAndExpectText('What is 2+2? Answer with only the number.', 'before'),
    { call: { method: 'suspend' } },
    ...expectState('suspended'),
    { call: { method: 'resume' } },
    ...askAndExpectText('What is 3+3? Answer with only the number.', 'after')
  ],
  'llm',
  60000,
  ['smoke']
)
/**
 * Both calls are in flight at once, which is the whole test: the lifecycle
 * coordinator has to serialise them rather than interleave. `settle` insists
 * each one resolved -- a rejection here is the failure the test looks for --
 * and the teardown's unconditional resume decides the state, since which of
 * the two landed last is exactly what this test does not fix.
 */
export const lifecycleRapidToggle = createLifecycleTest(
  'lifecycle-rapid-toggle',
  [
    { start: { method: 'suspend', as: 'suspending' } },
    { start: { method: 'resume', as: 'resuming' } },
    { settle: { of: '$suspending' } },
    { settle: { of: '$resuming' } },
    { call: { method: 'resume' } },
    ...expectState('active')
  ],
  'none',
  30000,
  ['smoke']
)
/**
 * Suspends with a completion already running. The in-flight call must still
 * resolve: work that was admitted before the suspend is not what suspend is
 * there to block.
 */
export const lifecycleSuspendDuringInference = createLifecycleTest(
  'lifecycle-suspend-during-inference',
  [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      start: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [{ role: 'user', content: 'Count from 1 to 20, one number per line.' }],
          stream: false
        },
        as: 'inflight'
      }
    },
    { call: { method: 'suspend' } },
    { settle: { of: '$inflight', as: 'run' } },
    { call: { method: 'resume' } },
    ...expectState('active'),
    { project: { from: '$run', path: 'text', as: 'text' } },
    { assert: { on: '$text', named: 'nonEmptyText' } }
  ],
  'llm',
  60000
)
export const lifecycleStateTransitions = createLifecycleTest(
  'lifecycle-state-transitions',
  [
    { call: { method: 'resume' } },
    ...expectState('active'),
    { call: { method: 'suspend' } },
    ...expectState('suspended'),
    { call: { method: 'resume' } },
    ...expectState('active')
  ],
  'none',
  15000,
  ['smoke']
)
/**
 * Inference asked for while suspended is refused, and works again after
 * resume. The refusal is the claim, so it is a `callError`: a body that merely
 * caught "something threw" would pass on a client that threw for any reason.
 */
export const lifecycleBlockedCompletion = createLifecycleTest(
  'lifecycle-blocked-completion',
  [
    { useModel: { deps: ['llm'], as: 'model' } },
    { call: { method: 'suspend' } },
    {
      callError: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [{ role: 'user', content: 'Test' }],
          stream: false
        },
        as: 'blocked'
      }
    },
    {
      assert: {
        on: '$blocked',
        named: 'errorMatches',
        with: { code: LIFECYCLE_OPERATION_BLOCKED }
      }
    },
    { call: { method: 'resume' } },
    ...expectState('active'),
    ...askAndExpectText('What is 2+2? Answer with only the number.', 'after')
  ],
  'llm',
  60000
)
export const lifecycleBlockedRegistry = createLifecycleTest('lifecycle-blocked-registry', [
  { call: { method: 'suspend' } },
  { callError: { method: 'modelRegistryList', as: 'blocked' } },
  {
    assert: {
      on: '$blocked',
      named: 'errorMatches',
      with: { code: LIFECYCLE_OPERATION_BLOCKED }
    }
  },
  { call: { method: 'resume' } },
  ...expectState('active'),
  { call: { method: 'modelRegistryList', as: 'models' } },
  { assert: { on: '$models', named: 'lengthAtLeast', with: { length: 1 } } }
])

export const lifecycleTests = [
  lifecycleSuspendResumeBasic,
  lifecycleSuspendIdempotent,
  lifecycleResumeIdempotent,
  lifecycleSuspendResumeInference,
  lifecycleRapidToggle,
  lifecycleSuspendDuringInference,
  lifecycleStateTransitions,
  lifecycleBlockedCompletion,
  lifecycleBlockedRegistry
] as const
