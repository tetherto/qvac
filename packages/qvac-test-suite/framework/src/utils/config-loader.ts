import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QvacTestConfig } from '../types/config.js';

/**
 * Load configuration from qvac-test.config.ts
 * @param configDir Directory containing qvac-test.config.ts (defaults to cwd)
 */
export async function loadConfig(configDir: string = process.cwd()): Promise<QvacTestConfig> {
  const tsConfigPath = path.resolve(configDir, 'qvac-test.config.ts');
  const jsConfigPath = path.resolve(configDir, 'qvac-test.config.js');

  let configPath: string;

  if (fs.existsSync(jsConfigPath)) {
    configPath = jsConfigPath;
  } else if (fs.existsSync(tsConfigPath)) {
    configPath = tsConfigPath;
  } else {
    throw new Error(`Config file not found in ${configDir} (looking for qvac-test.config.ts or .js)`);
  }

  try {
    const configUrl = pathToFileURL(configPath).href;
    const module = await import(configUrl);
    return module.default;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config from ${configPath}: ${errorMessage}`);
  }
}

/**
 * Find config file by walking up directory tree
 */
export function findConfig(startDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const tsConfigPath = path.join(currentDir, 'qvac-test.config.ts');
    const jsConfigPath = path.join(currentDir, 'qvac-test.config.js');

    if (fs.existsSync(tsConfigPath) || fs.existsSync(jsConfigPath)) {
      return currentDir;
    }

    currentDir = path.dirname(currentDir);
  }

  return null;
}
