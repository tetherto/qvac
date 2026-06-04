/**
 * Config loader for Bare runtime
 * Uses bare-fs and bare-path modules
 */
import fs from "bare-fs";
import path from "bare-path";
import process from "bare-process";
import { validateConfig, type QvacConfig } from "./config-utils";
import {
  ConfigFileInvalidError,
  ConfigFileParseFailedError,
} from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

declare function require(modulePath: string): { default?: unknown };

const SUPPORTED_CONFIG_FILE_EXTS = [".js", ".json"];

const logger = getClientLogger();

function findProjectRoot(): string {
  return process.cwd();
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function assertBareConfigExtension(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_CONFIG_FILE_EXTS.includes(ext)) {
    throw new ConfigFileInvalidError(
      filePath,
      "Given config file format unsupported on this platform. Use qvac.config.js or qvac.config.json in the project root, or set QVAC_CONFIG_PATH to a .js or .json file.",
    );
  }
}

function loadConfigFromPath(filePath: string): QvacConfig {
  assertBareConfigExtension(filePath);
  try {
    const configModule: { default?: unknown } = require(filePath);
    return validateConfig(configModule.default || configModule);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      filePath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function findConfigFile(searchDir: string): string | undefined {
  const configFiles = SUPPORTED_CONFIG_FILE_EXTS.map(
    (ext) => `qvac.config${ext}`,
  );

  for (const name of configFiles) {
    const filePath = path.resolve(searchDir, name);
    if (fileExists(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

/**
 * Resolution order for Bare:
 * 1. QVAC_CONFIG_PATH environment variable
 * 2. Config file in project root (qvac.config.js, qvac.config.json)
 * 3. SDK defaults
 */
// eslint-disable-next-line @typescript-eslint/require-await -- matches Node/Expo resolver signature
export async function resolveConfig(): Promise<QvacConfig | undefined> {
  const configPath = process.env["QVAC_CONFIG_PATH"];

  if (configPath) {
    const normalizedPath = path.resolve(configPath);

    if (fileExists(normalizedPath)) {
      const config = loadConfigFromPath(normalizedPath);

      logger.info(`✅ Loaded config from: ${normalizedPath}`);
      return config;
    }
  }

  const projectRoot = findProjectRoot();
  if (projectRoot) {
    const configFilePath = findConfigFile(projectRoot);
    if (configFilePath) {
      const config = loadConfigFromPath(configFilePath);

      logger.info(`✅ Loaded config from: ${configFilePath}`);
      return config;
    }
  }

  logger.info("ℹ️ No config file found, using SDK defaults");
  return undefined;
}
