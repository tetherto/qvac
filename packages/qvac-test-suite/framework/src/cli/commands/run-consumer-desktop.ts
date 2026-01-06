import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../utils/config-loader.js';

interface ConsumerOptions {
  runId: string;
  mqttBroker?: string;
  config: string;
  platform?: string;
}

export async function runConsumerDesktop(options: ConsumerOptions) {
  try {
    const config = await loadConfig(options.config);

    if (!config.consumers.desktop) {
      throw new Error('No desktop consumer configuration found');
    }

    const platform = options.platform || 'desktop';
    const configDir = path.resolve(options.config);

    console.log('🚀 Running consumer...\n');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const runnerPath = path.resolve(__dirname, '../runners/run-consumer-desktop-inplace.js');

    const args = [`--runId=${options.runId}`, `--config=${configDir}`, `--platform=${platform}`];
    if (options.mqttBroker) args.push(`--mqtt-broker=${options.mqttBroker}`);

    // Mocha-like behavior: run in-place using the project's environment.
    // If the entry is TypeScript and Node can't import it in the user's setup,
    // the runner will fail with a clear error; the fix is to point config to compiled JS.
    const child = spawn('node', [runnerPath, ...args], {
      stdio: 'inherit',
      cwd: configDir,
    });

    child.on('error', (err) => {
      console.error(`❌ Failed to start consumer: ${err.message}`);
      process.exit(1);
    });

    process.on('SIGINT', () => child.kill('SIGINT' as any));
    process.on('SIGTERM', () => child.kill('SIGTERM' as any));

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to run consumer:', errorMessage);
    process.exit(1);
  }
}
