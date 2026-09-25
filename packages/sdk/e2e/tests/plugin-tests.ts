import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * A plugin call expected to be refused.
 *
 * The happy-path tests went through the fixture's own client wrapper, the way
 * a real consumer would; the wrapper exists to make exactly these payloads
 * impossible, so the error paths call `invokePlugin` directly. As steps both
 * are the same call, and what the wrapper added -- the handler name -- is now
 * written where a reader can see it.
 */
const pluginRejects = (handler: string, params: Record<string, unknown>): Step[] => [
  { useModel: { deps: ['echo'], as: 'model' } },
  {
    callError: {
      method: 'invokePlugin',
      params: { modelId: '$model', handler, params },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

export const pluginEchoLoadModel: TestDefinition = {
  testId: 'plugin-echo-load-model',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['echo'], as: 'model' } },
    { assert: { on: '$model', named: 'nonEmptyText' } }
  ],
  metadata: {
    category: 'plugin',
    dependency: 'echo',
    estimatedDurationMs: 10000
  }
}

export const pluginEchoInvoke: TestDefinition = {
  testId: 'plugin-echo-invoke',
  params: { message: 'hello from e2e' },
  expectation: {
    validation: 'contains-all',
    contains: ['hello from e2e']
  },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['echo'], as: 'model' } },
    {
      call: {
        method: 'invokePlugin',
        params: { modelId: '$model', handler: 'echo', params: { message: '$params.message' } },
        as: 'echoed'
      }
    },
    { project: { from: '$echoed', path: 'result.message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: {
    category: 'plugin',
    dependency: 'echo',
    estimatedDurationMs: 10000
  }
}

export const pluginEchoInvokeStream: TestDefinition = {
  testId: 'plugin-echo-invoke-stream',
  params: { message: 'streaming chunks test' },
  expectation: {
    validation: 'contains-all',
    contains: ['streaming', 'chunks', 'test']
  },
  steps: [
    { useModel: { deps: ['echo'], as: 'model' } },
    {
      call: {
        method: 'invokePluginStream',
        collect: 'all',
        params: {
          modelId: '$model',
          handler: 'echoStream',
          params: { message: '$params.message' }
        },
        as: 'streamed'
      }
    },
    { project: { from: '$streamed', path: 'all[*].chunk', join: ' ', as: 'text' } },
    { assert: { on: '$text', use: 'expectation' } }
  ],
  metadata: {
    category: 'plugin',
    dependency: 'echo',
    estimatedDurationMs: 10000
  }
}

export const pluginEchoValidationError: TestDefinition = {
  testId: 'plugin-echo-validation-error',
  params: {},
  expectation: {
    validation: 'throws-error',
    errorContains: 'Request validation failed'
  },
  steps: pluginRejects('echo', { notAMessage: 12345 }),
  metadata: {
    category: 'plugin',
    dependency: 'echo',
    estimatedDurationMs: 5000
  }
}

export const pluginInvokeUnknownHandler: TestDefinition = {
  testId: 'plugin-invoke-unknown-handler',
  params: { message: 'test' },
  expectation: {
    validation: 'throws-error',
    errorContains: 'Handler "nonExistentHandler" not found'
  },
  steps: pluginRejects('nonExistentHandler', { message: '$params.message' }),
  metadata: {
    category: 'plugin',
    dependency: 'echo',
    estimatedDurationMs: 5000
  }
}

export const pluginLoadUnknownType: TestDefinition = {
  testId: 'plugin-load-unknown-type',
  params: { modelType: 'nonexistent-plugin-type-xyz' },
  expectation: {
    validation: 'throws-error',
    errorContains: 'Plugin not found for model type'
  },
  steps: [
    {
      callError: {
        method: 'loadModel',
        params: {
          modelSrc: '/nonexistent/path/fake-model.bin',
          modelType: '$params.modelType'
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: {
    category: 'plugin',
    dependency: 'none',
    estimatedDurationMs: 5000
  }
}

export const pluginTests: TestDefinition[] = [
  pluginEchoLoadModel,
  pluginEchoInvoke,
  pluginEchoInvokeStream,
  pluginEchoValidationError,
  pluginInvokeUnknownHandler,
  pluginLoadUnknownType
]
