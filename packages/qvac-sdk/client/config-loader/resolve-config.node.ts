/**
 * Config loader for Node.js runtime
 * Uses Node.js fs/promises and path modules
 */
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import {
  validateConfig,
  parseJsonConfig,
  type QvacConfig,
} from "./config-utils";
import { ConfigFileParseFailedError } from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

async function findProjectRoot(): Promise<string | undefined> {
  try {
    let currentDir = path.resolve(process.cwd());
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      try {
        const packageJsonPath = path.join(currentDir, "package.json");
        await fs.access(packageJsonPath);
        return currentDir;
      } catch {
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          break;
        }
        currentDir = parentDir;
      }
    }
  } catch {
    // Fall through
  }

  return process.cwd();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFile(filePath: string): Promise<string> {
  return await fs.readFile(filePath, { encoding: "utf-8" });
}

async function loadJsonConfig(filePath: string): Promise<QvacConfig> {
  const content = await readFile(filePath);
  const parsed = parseJsonConfig(content, filePath);
  return validateConfig(parsed);
}

async function loadJsConfig(filePath: string): Promise<QvacConfig> {
  try {
    let importPath = filePath;

    // Windows requires file:// URLs for dynamic imports
    if (process.platform === "win32" && !process.env["JEST_WORKER_ID"]) {
      importPath = pathToFileURL(filePath).toString();
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const configModule: { default?: unknown } = await import(importPath);
    return validateConfig(configModule.default || configModule);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      filePath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

async function findConfigFile(
  searchDir: string,
): Promise<{ path: string; type: "json" | "js" | "ts" } | undefined> {
  const configFiles = [
    { name: "qvac.config.ts", type: "ts" as const },
    { name: "qvac.config.js", type: "js" as const },
    { name: "qvac.config.json", type: "json" as const },
  ];

  for (const { name, type } of configFiles) {
    const filePath = path.resolve(searchDir, name);
    if (await fileExists(filePath)) {
      return { path: filePath, type };
    }
  }

  return undefined;
}

/**
 * Resolution order for Node.js:
 * 1. QVAC_CONFIG_PATH environment variable
 * 2. Config file in project root (qvac.config.ts, qvac.config.js, qvac.config.json)
 * 3. SDK defaults
 */
export async function resolveConfig(): Promise<QvacConfig | undefined> {
  const configPath = process.env["QVAC_CONFIG_PATH"] as string | undefined;

  if (configPath) {
    const normalizedPath = path.resolve(configPath);

    if (await fileExists(normalizedPath)) {
      const ext = normalizedPath.endsWith(".json")
        ? "json"
        : normalizedPath.endsWith(".ts")
          ? "ts"
          : "js";
      const config =
        ext === "json"
          ? await loadJsonConfig(normalizedPath)
          : await loadJsConfig(normalizedPath);

      logger.info(`✅ Loaded config from: ${normalizedPath}`);
      return config;
    }
  }

  const projectRoot = await findProjectRoot();
  if (projectRoot) {
    const configFile = await findConfigFile(projectRoot);
    if (configFile) {
      const config =
        configFile.type === "json"
          ? await loadJsonConfig(configFile.path)
          : await loadJsConfig(configFile.path);

      logger.info(`✅ Loaded config from: ${configFile.path}`);
      return config;
    }
  }

  logger.info("ℹ️ No config file found, using SDK defaults");
  return undefined;
}
