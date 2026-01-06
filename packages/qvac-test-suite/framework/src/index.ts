// Type exports
export type { QvacTestConfig } from './types/config.js';
export type { Expectation } from './schemas/expectations.js';
export type { TestDefinition } from './types/test-definition.js';
export type { TestExecutor, TestResult } from './core/consumer-base.js';
export type { TestHandler, TestExecutorConfig } from './types/test-handler.js';

// Schema exports (for validation)
export { expectationSchema } from './schemas/expectations.js';
export { mqttConnectionSchema } from './schemas/mqtt-config.js';
export { testDefinitionSchema } from './types/test-definition.js';
export { qvacTestConfigSchema } from './types/config.js';
export {
  consumerRegistrationSchema,
  testRequestSchema,
  testStartSchema,
  testResultSchema,
  heartbeatSchema,
  batchCompleteSchema,
  registerAckSchema,
  testAssignmentSchema,
} from './schemas/messages.js';

// Helper function exports
export { defineTests } from './core/define-tests.js';
export { defineConfig } from './types/config.js';

// Core exports
export { BatchOrchestrator } from './core/batch-orchestrator.js';
export { ConsumerBase } from './core/consumer-base.js';
export { createExecutor } from './core/test-executor.js';

// Utility exports
export { findConfig, loadConfig } from './utils/config-loader.js';
export { loadTests } from './utils/test-loader.js';
export { ValidationHelpers } from './utils/validation-helpers.js';
export {
  createMqttClient,
  buildMqttOptions,
  buildMqttConnectionConfig,
  logMqttConnectionSecurity,
} from './utils/mqtt-connection.js';
export type { MqttConnectionConfig } from './utils/mqtt-connection.js';
