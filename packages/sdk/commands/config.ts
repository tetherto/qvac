import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateConfig,
  parseJsonConfig,
} from "@/client/config-loader/config-utils";
import type { QvacConfig } from "@/schemas/sdk-config";
import {
  ConfigFileInvalidError,
  ConfigFileParseFailedError,
} from "@/utils/errors-client";

export const CONFIG_CANDIDATES = [
  "qvac.config.json",
  "qvac.config.js",
  "qvac.config.mjs",
  "qvac.config.ts",
];

export function findBundleConfigFile(
  projectRoot: string,
  explicitPath?: string,
): string | null {
  if (explicitPath) {
    const absPath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(projectRoot, explicitPath);
    if (fs.existsSync(absPath)) {
      return absPath;
    }
    throw new ConfigFileInvalidError(
      absPath,
      "Config file not found at explicit path",
    );
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

export async function loadBundleConfig(
  configPath: string,
): Promise<QvacConfig> {
  const ext = path.extname(configPath).toLowerCase();

  if (ext === ".json") {
    const content = await fsp.readFile(configPath, "utf8");
    const parsed = parseJsonConfig(content, configPath);
    return validateConfig(parsed);
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

async function loadJsConfig(configPath: string): Promise<QvacConfig> {
  try {
    let importPath = configPath;
    if (process.platform === "win32") {
      importPath = pathToFileURL(configPath).toString();
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const configModule: { default?: unknown } = await import(importPath);
    return validateConfig(configModule.default ?? configModule);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      configPath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

async function loadTsConfig(configPath: string): Promise<QvacConfig> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const tsxApiPath = require.resolve("tsx/esm/api");
    const tsxModule = (await import(tsxApiPath)) as {
      tsImport: (
        configFilePath: string,
        baseUrl: string,
      ) => Promise<{ default?: unknown }>;
    };
    const mod = await tsxModule.tsImport(configPath, import.meta.url);
    return validateConfig(mod.default ?? mod);
  } catch (error) {
    throw new ConfigFileParseFailedError(
      configPath,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}
