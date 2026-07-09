import type { TestDefinition } from '@tetherto/qvac-test-suite'

export const pluginEchoLoadModel: TestDefinition = {
  testId: 'plugin-echo-load-model',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
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
