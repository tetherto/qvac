/**
 * Config loader for Bare runtime
 * Uses bare-fs and bare-path modules
 */
import fs from "bare-fs";
import path from "bare-path";
import process from "bare-process";
import {
  validateConfig,
  parseJsonConfig,
  type QvacConfig,
} from "./config-utils";
import { ConfigFileParseFailedError } from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

function findProjectRoot(): string {
  return process.cwd();
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readFile(filePath: string): string {
  const result = fs.readFileSync(filePath, "utf-8");
  return typeof result === "string" ? result : result.toString("utf-8");
}

function loadJsonConfig(filePath: string): QvacConfig {
  const content = readFile(filePath);
  const parsed = parseJsonConfig(content, filePath);
  return validateConfig(parsed);
}

async function loadJsConfig(filePath: string): Promise<QvacConfig> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const configModule: { default?: unknown } = await import(filePath);
    return validateConfig(configModule.default || configModule);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      filePath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

function findConfigFile(
  searchDir: string,
): { path: string; type: "json" | "js" | "ts" } | undefined {
  const configFiles = [
    { name: "qvac.config.ts", type: "ts" as const },
    { name: "qvac.config.js", type: "js" as const },
    { name: "qvac.config.json", type: "json" as const },
  ];

  for (const { name, type } of configFiles) {
    const filePath = path.resolve(searchDir, name);
    if (fileExists(filePath)) {
      return { path: filePath, type };
    }
  }

  return undefined;
}

/**
 * Resolution order for Bare:
 * 1. QVAC_CONFIG_PATH environment variable
 * 2. Config file in project root (qvac.config.ts, qvac.config.js, qvac.config.json)
 * 3. SDK defaults
 */
export async function resolveConfig(): Promise<QvacConfig | undefined> {
  const configPath = process.env["QVAC_CONFIG_PATH"];

  if (configPath) {
    const normalizedPath = path.resolve(configPath);

    if (fileExists(normalizedPath)) {
      const ext = normalizedPath.endsWith(".json")
        ? "json"
        : normalizedPath.endsWith(".ts")
          ? "ts"
          : "js";
      const config =
        ext === "json"
          ? loadJsonConfig(normalizedPath)
          : await loadJsConfig(normalizedPath);

      logger.info(`✅ Loaded config from: ${normalizedPath}`);
      return config;
    }
  }

  const projectRoot = findProjectRoot();
  if (projectRoot) {
    const configFile = findConfigFile(projectRoot);
    if (configFile) {
      const config =
        configFile.type === "json"
          ? loadJsonConfig(configFile.path)
          : await loadJsConfig(configFile.path);

      logger.info(`✅ Loaded config from: ${configFile.path}`);
      return config;
    }
  }

  logger.info("ℹ️ No config file found, using SDK defaults");
  return undefined;
}
