// Type exports
export type { QvacTestConfig } from './types/config.js'
export type { Expectation } from './schemas/expectations.js'
export type { TestDefinition } from './types/test-definition.js'
export type { TestExecutor, TestResult } from './core/consumer-base.js'
export type { TestHandler, TestExecutorConfig } from './types/test-handler.js'
export type { TestDefinitions, ExtractTest, HandlerFn } from './core/base-executor.js'

// Schema exports (for validation)
export { expectationSchema } from './schemas/expectations.js'
export { mqttConnectionSchema } from './schemas/mqtt-config.js'
export { testDefinitionSchema } from './types/test-definition.js'
export { qvacTestConfigSchema } from './types/config.js'
export {
  consumerRegistrationSchema,
  testRequestSchema,
  testPrepareSchema,
  testStartSchema,
  testReloadSchema,
  testResultSchema,
  heartbeatSchema,
  queueEmptySchema,
  batchCompleteSchema,
  testQueueItemSchema,
  registerAckSchema,
  testAssignmentSchema
} from './schemas/messages.js'
export type { QueueEmpty, RegisterAck, TestPrepare, TestQueueItem } from './schemas/messages.js'

// Helper function exports
export { defineTests } from './core/define-tests.js'
export { defineConfig } from './types/config.js'

// Core exports
export { BatchOrchestrator } from './core/batch-orchestrator.js'
export { ConsumerBase } from './core/consumer-base.js'
export { createExecutor } from './core/test-executor.js'
export {
  startNodeMemoryPoller,
  startDesktopMemoryPoller,
  type NodeMemoryPollerHandle,
  type NodeMemoryPollerOptions,
  type DesktopMemoryPollerHandle,
  type DesktopMemoryPollerOptions
} from './core/node-memory-poller.js'

// Executor base classes (desktop-compatible)
export { BaseExecutor, SkipExecutor } from './core/base-executor.js'

// Utility exports
export { findConfig, loadConfig } from './utils/config-loader.js'
export { loadTests } from './utils/test-loader.js'
export { ValidationHelpers, chainExpectation } from './utils/validation-helpers.js'
export {
  createMqttClient,
  buildMqttOptions,
  buildMqttConnectionConfig,
  logMqttConnectionSecurity
} from './utils/mqtt-connection.js'
export type { MqttConnectionConfig, CreateMqttClientOptions } from './utils/mqtt-connection.js'
