import { config as loadDotenv } from 'dotenv';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConsumerBase, type TestExecutor } from '../../core/consumer-base.js';
import { loadConfig } from '../../utils/config-loader.js';
import { buildMqttConnectionConfig, createMqttClient } from '../../utils/mqtt-connection.js';

function readArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = args.find((a) => a.startsWith(prefix));
  if (!match) return undefined;
  return match.slice(prefix.length);
}

function requireArg(args: string[], name: string): string {
  const value = readArg(args, name);
  if (!value) {
    console.error(`❌ --${name} is required`);
    process.exit(1);
  }
  return value;
}

async function loadExecutor(entryAbsPath: string): Promise<TestExecutor> {
  const entryUrl = pathToFileURL(entryAbsPath).href;
  const mod = await import(entryUrl);
  const executor =
    (mod as { executor?: unknown; default?: unknown }).executor ?? (mod as { default?: unknown }).default;

  if (!executor || typeof executor !== 'object' || !('executeTest' in executor)) {
    throw new Error(
      `Consumer entry must export { executor } (or default) with executeTest(testId, context, params, expectation)`
    );
  }

  return executor as TestExecutor;
}

async function main() {
  const args = process.argv.slice(2);

  const runId = requireArg(args, 'runId');
  const configDir = path.resolve(readArg(args, 'config') ?? process.cwd());
  const platform = readArg(args, 'platform') ?? 'desktop';
  const mqttBrokerOverride = readArg(args, 'mqtt-broker');

  // Load .env from the config directory (mocha-like behavior)
  loadDotenv({ path: path.join(configDir, '.env') });

  const config = await loadConfig(configDir);
  if (!config.consumers.desktop) {
    throw new Error('No desktop consumer configuration found');
  }

  const entryAbs = path.resolve(configDir, config.consumers.desktop.entry);
  const executor = await loadExecutor(entryAbs);

  const mqttConfig = buildMqttConnectionConfig(config);
  if (mqttBrokerOverride) {
    mqttConfig.brokerUrl = mqttBrokerOverride;
  }

  const client = createMqttClient(mqttConfig);
  const consumerId = `consumer-${platform}-${os.hostname()}-${Date.now()}`;

  const consumer = new ConsumerBase(client, consumerId, platform, runId, executor, {
    log: (msg) => console.log(msg),
    updateStats: () => {},
    onShutdown: () => process.exit(0),
  });

  consumer.setupMqttHandlers();

  process.on('SIGINT', () => consumer.forceShutdown());
  process.on('SIGTERM', () => consumer.forceShutdown());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('❌ Failed to start consumer:', message);
  process.exit(1);
});
