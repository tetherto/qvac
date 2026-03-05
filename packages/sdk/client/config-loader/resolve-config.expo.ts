/**
 * Config loader for Expo/React Native runtime
 * Only uses expo-file-system - no Node.js or Bare imports
 */
import { File, Paths } from "expo-file-system";
import {
  validateConfig,
  parseJsonConfig,
  type QvacConfig,
} from "./config-utils";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

function fileExists(filePath: string): boolean {
  try {
    const file = new File(filePath);
    return file.exists;
  } catch {
    return false;
  }
}

async function readFile(filePath: string): Promise<string> {
  const file = new File(filePath);
  return await file.text();
}

async function loadJsonConfig(filePath: string): Promise<QvacConfig> {
  const content = await readFile(filePath);
  const parsed = parseJsonConfig(content, filePath);
  return validateConfig(parsed);
}

/**
 * Resolution order for Expo:
 * 1. QVAC_CONFIG_PATH environment variable (if set)
 * 2. Default Expo path: ${Paths.document.uri}qvac.config.json
 * 3. SDK defaults
 *
 * Note: Only JSON config files are supported in React Native
 */
export async function resolveConfig(): Promise<QvacConfig | undefined> {
  // Check environment variable first
  const configPath: string | undefined =
    typeof process !== "undefined"
      ? (process.env?.["QVAC_CONFIG_PATH"] as string | undefined)
      : undefined;

  if (configPath) {
    if (fileExists(configPath)) {
      logger.info(`✅ Loaded config from: ${configPath}`);
      return await loadJsonConfig(configPath);
    }
  }

  // Try default Expo document directory path
  try {
    const documentDir = Paths.document.uri;
    if (documentDir) {
      const defaultExpoConfigPath = `${documentDir}qvac.config.json`;

      if (fileExists(defaultExpoConfigPath)) {
        logger.info(`✅ Loaded config from: ${defaultExpoConfigPath}`);
        return await loadJsonConfig(defaultExpoConfigPath);
      }
    }
  } catch {
    // Paths not available
  }

  logger.info("ℹ️ No config file found, using SDK defaults");
  return undefined;
}
