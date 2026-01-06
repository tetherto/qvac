import { BatchOrchestrator } from '../../core/batch-orchestrator.js';
import { config as loadDotenv } from 'dotenv';
import * as path from 'node:path';
import { loadConfig } from '../../utils/config-loader.js';
import { loadTests } from '../../utils/test-loader.js';
import { buildMqttConnectionConfig, createMqttClient } from '../../utils/mqtt-connection.js';

interface ProducerOptions {
  runId?: string;
  mqttBroker?: string;
  config: string;
  consumerTimeout?: string;
  filter?: string;
}

export async function runProducer(options: ProducerOptions) {
  try {
    console.log('🚀 Starting QVAC Test Producer\n');

    const runId = options.runId || `run-${Date.now()}`;
    const configDir = path.resolve(options.config);

    // Load .env from config directory (match consumer behavior)
    loadDotenv({ path: path.join(configDir, '.env') });

    console.log(`📂 Loading config from: ${configDir}`);
    const config = await loadConfig(configDir);
    console.log(`✅ Config loaded\n`);

    const mqttConfig = buildMqttConnectionConfig(config);

    if (options.mqttBroker) {
      mqttConfig.brokerUrl = options.mqttBroker;
    }

    console.log(`📋 Loading tests from: ${config.testDir}`);
    let tests = await loadTests(config, configDir);

    if (options.filter) {
      const filters = options.filter.split(',').map((f) => f.trim());
      console.log(`🔍 Filtering tests by: ${filters.join(', ')}`);

      const originalCount = tests.length;
      tests = tests.filter((test) =>
        filters.some((filter) => test.testId.startsWith(filter) || test.metadata?.category === filter)
      );

      console.log(`📋 Filtered: ${tests.length} of ${originalCount} tests\n`);
    } else {
      console.log(`✅ Loaded ${tests.length} tests\n`);
    }

    const consumerTimeoutSec = parseInt(options.consumerTimeout || '30', 10);

    const client = createMqttClient(mqttConfig);
    const orchestrator = new BatchOrchestrator(client, runId, false, consumerTimeoutSec);

    orchestrator.buildTestQueue(tests);

    setTimeout(() => {
      orchestrator.start();
    }, 1000);

    process.on('SIGINT', () => orchestrator.shutdown());
    process.on('SIGTERM', () => orchestrator.shutdown());
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to start producer:', errorMessage);
    process.exit(1);
  }
}
