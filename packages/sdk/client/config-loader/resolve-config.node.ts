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
import {
  ConfigFileInvalidError,
  ConfigFileParseFailedError,
} from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

/** Config filenames searched under a project root (bundle/verify/commands). */
export const CONFIG_CANDIDATES = [
  "qvac.config.ts",
  "qvac.config.mjs",
  "qvac.config.js",
  "qvac.config.json",
] as const;

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
  } catch (error) {
    logger.debug("Project root search failed, using cwd:", { error });
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

async function loadTsConfig(filePath: string): Promise<QvacConfig> {
  let tsxApiPath: string;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    tsxApiPath = require.resolve("tsx/esm/api");
  } catch (error) {
    throw new ConfigFileInvalidError(
      filePath,
      "Loading a TypeScript qvac.config.ts requires the optional peer dependency `tsx`. Install it as a devDependency, or use qvac.config.mjs / qvac.config.js / qvac.config.json instead.",
      error,
    );
  }

  try {
    const tsxModule = (await import(tsxApiPath)) as {
      tsImport: (
        configFilePath: string,
        baseUrl: string,
      ) => Promise<{ default?: unknown }>;
    };
    const mod = await tsxModule.tsImport(filePath, import.meta.url);
    return validateConfig(mod.default ?? mod);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      filePath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/** Load and validate a config file at an explicit path (used by RPC init and commands). */
export async function loadConfigFromPath(
  configPath: string,
): Promise<QvacConfig> {
  const ext = path.extname(configPath).toLowerCase();

  if (ext === ".json") {
    return loadJsonConfig(configPath);
  }
  if (ext === ".js" || ext === ".mjs") {
    return loadJsConfig(configPath);
  }
  if (ext === ".ts") {
    return loadTsConfig(configPath);
  }

  throw new ConfigFileInvalidError(
    configPath,
    `Unsupported config format: ${ext}. Use .json, .js, .mjs, or .ts`,
  );
}

async function findConfigFileInDir(
  searchDir: string,
): Promise<string | undefined> {
  for (const name of CONFIG_CANDIDATES) {
    const filePath = path.resolve(searchDir, name);
    if (await fileExists(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

/**
 * Resolve a config file path under `projectRoot` (or an explicit relative/absolute path).
 * Used by `bundleSdk` / `verifyBundle` when the caller supplies `projectRoot`.
 */
export async function resolveConfigFileInProject(
  projectRoot: string,
  explicitPath?: string,
): Promise<string | null> {
  if (explicitPath) {
    const absPath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(projectRoot, explicitPath);
    if (await fileExists(absPath)) {
      return absPath;
    }
    throw new ConfigFileInvalidError(
      absPath,
      "Config file not found at explicit path",
    );
  }

  const found = await findConfigFileInDir(projectRoot);
  return found ?? null;
}

/**
 * Load `qvac.config.*` for a known project directory (commands tooling API).
 */
export async function resolveConfigForProject(
  projectRoot: string,
  explicitPath?: string,
): Promise<{ configPath: string | null; config: QvacConfig }> {
  const configPath = await resolveConfigFileInProject(
    projectRoot,
    explicitPath,
  );
  if (!configPath) {
    return { configPath: null, config: {} };
  }
  const config = await loadConfigFromPath(configPath);
  return { configPath, config };
}

function getResourcesPath(): string | undefined {
  const { resourcesPath } = process as { resourcesPath?: string };
  return typeof resourcesPath === "string" ? resourcesPath : undefined;
}

async function findPackagedConfig(): Promise<string | undefined> {
  const resourcesPath = getResourcesPath();
  if (!resourcesPath) return undefined;

  const candidates = [
    path.join(resourcesPath, "app", "qvac.config.json"),
    path.join(resourcesPath, "app.asar.unpacked", "qvac.config.json"),
    path.join(resourcesPath, "qvac.config.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Resolution order for Node.js:
 * 1. QVAC_CONFIG_PATH environment variable
 * 2. Packaged Electron app (via process.resourcesPath)
 * 3. Config file in project root (qvac.config.ts, qvac.config.js, qvac.config.json)
 * 4. SDK defaults
 */
export async function resolveConfig(): Promise<QvacConfig | undefined> {
  const configPath = process.env["QVAC_CONFIG_PATH"] as string | undefined;

  if (configPath) {
    const normalizedPath = path.resolve(configPath);

    if (await fileExists(normalizedPath)) {
      const config = await loadConfigFromPath(normalizedPath);

      logger.info(`✅ Loaded config from: ${normalizedPath}`);
      return config;
    }
  }

  const packagedConfig = await findPackagedConfig();
  if (packagedConfig) {
    const config = await loadJsonConfig(packagedConfig);
    logger.info(`✅ Loaded config from packaged app: ${packagedConfig}`);
    return config;
  }

  const projectRoot = await findProjectRoot();
  if (projectRoot) {
    const configFilePath = await findConfigFileInDir(projectRoot);
    if (configFilePath) {
      const config = await loadConfigFromPath(configFilePath);

      logger.info(`✅ Loaded config from: ${configFilePath}`);
      return config;
    }
  }

  logger.info("ℹ️ No config file found, using SDK defaults");
  return undefined;
}
