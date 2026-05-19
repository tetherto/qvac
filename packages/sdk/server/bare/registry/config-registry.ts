import fs from "bare-fs";
import path from "bare-path";
import { getQvacPath } from "@/server/utils/qvac-paths";
import {
  CacheDirNotAbsoluteError,
  CacheDirNotWritableError,
  ConfigAlreadySetError,
} from "@/utils/errors-server";
import type { QvacConfig } from "@/schemas";
import {
  getServerLogger,
  setGlobalConsoleOutput,
  setGlobalLogLevel,
} from "@/logging";

const logger = getServerLogger();

const configRegistry: QvacConfig = {
  cacheDirectory: undefined,
  swarmRelays: undefined,
  loggerLevel: undefined,
  loggerConsoleOutput: undefined,
  httpDownloadConcurrency: undefined,
  registryDownloadMaxRetries: undefined,
  registryStreamTimeoutMs: undefined,
  deviceDefaults: undefined,
};

let configIsSet = false;

/**
 * Sets the SDK configuration. This can only be called ONCE during initialization.
 * After the first call, the config becomes immutable and any subsequent calls will throw.
 *
 * @param config - The configuration to set
 * @throws {ConfigAlreadySetError} If config has already been set
 * @throws {CacheDirNotAbsoluteError} If cacheDirectory is not an absolute path
 * @throws {CacheDirNotWritableError} If cacheDirectory is not writable
 */
export function setSDKConfig(config: QvacConfig) {
  // Enforce immutability - config can only be set once
  if (configIsSet) {
    throw new ConfigAlreadySetError();
  }

  if (config.cacheDirectory !== undefined && config.cacheDirectory !== null) {
    if (!path.isAbsolute(config.cacheDirectory)) {
      throw new CacheDirNotAbsoluteError();
    }

    try {
      fs.mkdirSync(config.cacheDirectory, { recursive: true });

      const testFile = path.join(config.cacheDirectory, ".qvac-test");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
    } catch (error) {
      throw new CacheDirNotWritableError(
        config.cacheDirectory,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    configRegistry.cacheDirectory = config.cacheDirectory;
    logger.info(`✅ Cache directory set to: ${config.cacheDirectory}`);
  }

  if (config.swarmRelays !== undefined && config.swarmRelays !== null) {
    configRegistry.swarmRelays = config.swarmRelays;
    logger.info(
      `✅ Swarm relays configured: ${config.swarmRelays.length} relay(s)`,
    );
  }

  if (config.loggerLevel !== undefined && config.loggerLevel !== null) {
    configRegistry.loggerLevel = config.loggerLevel;
    setGlobalLogLevel(config.loggerLevel);
    logger.info(`Log level set to: ${config.loggerLevel}`);
  }

  if (
    config.loggerConsoleOutput !== undefined &&
    config.loggerConsoleOutput !== null
  ) {
    configRegistry.loggerConsoleOutput = config.loggerConsoleOutput;
    setGlobalConsoleOutput(config.loggerConsoleOutput);
    logger.info(
      `Console output ${config.loggerConsoleOutput ? "enabled" : "disabled"}`,
    );
  }

  if (
    config.httpDownloadConcurrency !== undefined &&
    config.httpDownloadConcurrency !== null
  ) {
    configRegistry.httpDownloadConcurrency = config.httpDownloadConcurrency;
    logger.info(
      `HTTP download concurrency set to: ${config.httpDownloadConcurrency}`,
    );
  }

  if (
    config.registryDownloadMaxRetries !== undefined &&
    config.registryDownloadMaxRetries !== null
  ) {
    configRegistry.registryDownloadMaxRetries = config.registryDownloadMaxRetries;
    logger.info(
      `✅ Registry download max retries set to: ${config.registryDownloadMaxRetries}`,
    );
  }

  if (
    config.registryStreamTimeoutMs !== undefined &&
    config.registryStreamTimeoutMs !== null
  ) {
    configRegistry.registryStreamTimeoutMs = config.registryStreamTimeoutMs;
    logger.info(
      `✅ Registry stream timeout set to: ${config.registryStreamTimeoutMs}ms`,
    );
  }

  if (config.deviceDefaults !== undefined && config.deviceDefaults !== null) {
    configRegistry.deviceDefaults = config.deviceDefaults;
    logger.info(
      `✅ Device defaults configured: ${config.deviceDefaults.length} pattern(s)`,
    );
  }

  // Mark config as set - now it's immutable
  configIsSet = true;
}

export function getSDKConfig(): QvacConfig {
  return { ...configRegistry };
}

function getDefaultCacheDir() {
  return getQvacPath("models");
}

export function getConfiguredCacheDir(): string {
  return configRegistry.cacheDirectory || getDefaultCacheDir();
}
