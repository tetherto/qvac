/**
 * @qvac/sdk/electron-builder
 *
 * Electron-builder integration for QVAC SDK.
 * Provides automatic native addon tree-shaking and prebuild pruning.
 *
 * @compatible electron-builder >=25.0.0
 *
 * Usage:
 *   Option A - extends (minimal config):
 *     // package.json
 *     { "build": { "extends": "@qvac/sdk/electron-builder" } }
 *
 *   Option B - wrapper (flexible):
 *     // electron-builder.cjs
 *     const { withQvacElectronBuilder } = require("@qvac/sdk/electron-builder");
 *     module.exports = withQvacElectronBuilder({ appId: "...", ... });
 *
 * Log Level Control:
 *   - Set QVAC_LOG_LEVEL env var: off, error, warn, info, debug
 *   - Or call setLogLevel("debug") programmatically
 *   - Aligns with @qvac/logging conventions
 */

/**
 * Tested electron-builder version.
 */
const ELECTRON_BUILDER_COMPAT_RANGE = ">=25.0.0";

const {
  generateAddonExclusions,
  discoverQvacAddonPackages,
} = require("./addons.cjs");
const { mergeFilesWithExclusions } = require("./files.cjs");
const { createMergedAfterPackHook } = require("./hooks.cjs");
const { logger, setLogLevel } = require("./logger.cjs");
const { prunePrebuildsHook } = require("./prebuilds.cjs");

/**
 * Checks if the config uses universal arch (macOS) which is incompatible with
 * prebuild tree-shaking. Universal builds require @electron/universal to merge
 * x64 and arm64 binaries, but prebuilds have arch-specific directories which are incompatible.
 *
 * @param {object} config - electron-builder configuration
 * @param {object} [context] - electron-builder config function context
 * @throws {Error} If universal arch is detected
 */
function checkForUniversalArch(config, context) {
  const contextArch = context?.arch;
  if (contextArch === "universal" || contextArch === 4) {
    throw new Error(
      "[qvac:electron-builder] Universal arch is not supported.\n\n" +
        "  macOS universal builds are incompatible with native addon prebuilds.\n" +
        "  The @electron/universal merger cannot handle arch-specific prebuild directories.\n\n" +
        "  Solution: Configure separate arm64 and x64 targets instead of universal.\n"
    );
  }

  const macConfig = config.mac;
  if (!macConfig) return;

  const targets = Array.isArray(macConfig.target)
    ? macConfig.target
    : [macConfig.target];

  for (const target of targets) {
    if (!target) continue;

    const arch = typeof target === "object" ? target.arch : null;
    if (!arch) continue;

    const archList = Array.isArray(arch) ? arch : [arch];
    if (archList.includes("universal")) {
      throw new Error(
        "[qvac:electron-builder] Universal arch is not supported.\n\n" +
        "  macOS universal builds are incompatible with native addon prebuilds.\n" +
        "  The @electron/universal merger cannot handle arch-specific prebuild directories.\n\n" +
        "  Solution: Configure separate arm64 and x64 targets instead of universal.\n"
      );
    }
  }
}

/**
 * Wraps a user's electron-builder config with QVAC tree-shaking.
 * Injects addon exclusions and the afterPack prebuild pruning hook.
 *
 * @param {object|function} userConfig - User's electron-builder configuration (object or async function)
 * @param {object} [options] - Plugin options
 * @param {string} [options.projectDir] - Project directory (defaults to cwd)
 * @param {boolean} [options.strict] - If true, throws on missing/invalid manifest
 * @param {string} [options.logLevel] - Log level (off, error, warn, info, debug)
 * @returns {function} Async function returning merged config (for electron-builder)
 */
function withQvacElectronBuilder(userConfig, options = {}) {
  const {
    projectDir = process.cwd(),
    strict = false,
    logLevel,
  } = options;

  if (logLevel) {
    setLogLevel(logLevel);
  }

  logger.debug(
    `QVAC electron-builder integration (tested: electron-builder ${ELECTRON_BUILDER_COMPAT_RANGE})`
  );

  return async function (context) {
    const resolvedUserConfig =
      typeof userConfig === "function" ? await userConfig(context) : userConfig;

    logger.debug(`Project directory: ${projectDir}`);
    logger.debug(`Strict mode: ${strict}`);

    checkForUniversalArch(resolvedUserConfig, context);

    const addonExclusions = generateAddonExclusions(projectDir, strict);

    const existingFiles = resolvedUserConfig.files || ["**/*"];
    const mergedFiles = mergeFilesWithExclusions(
      existingFiles,
      addonExclusions
    );

    // IMPORTANT:
    // The QVAC worker runs in a separate "bare" process (not Electron), so it cannot
    // load JS modules from inside app.asar. Unless a project carefully unpacks all
    // required JS into the filesystem, packaged apps will stall when spawning the
    // worker. We default to disabling asar to ensure the worker can load.
    const asar =
      typeof resolvedUserConfig.asar === "undefined"
        ? false
        : resolvedUserConfig.asar;

    if (resolvedUserConfig.asar === true) {
      logger.warn(
        "asar is enabled. Ensure worker files are unpacked or the QVAC worker may fail to load."
      );
    }

    const mergedAfterPack = createMergedAfterPackHook(
      resolvedUserConfig.afterPack,
      projectDir
    );

    return {
      ...resolvedUserConfig,
      asar,
      files: mergedFiles,
      afterPack: mergedAfterPack,
    };
  };
}

/**
 * Creates a complete electron-builder config with QVAC tree-shaking.
 * For users who want a ready-to-use config with defaults.
 *
 * @param {object} options - Configuration options
 * @param {string} options.appId - Application ID
 * @param {string} options.productName - Product name
 * @param {string[]} [options.extraFiles] - Additional files to include
 * @param {object} [options.mac] - Mac-specific config
 * @param {object} [options.win] - Windows-specific config
 * @param {object} [options.linux] - Linux-specific config
 * @param {string} [options.projectDir] - Project directory
 * @param {boolean} [options.strict] - If true, throws on missing/invalid manifest
 * @param {string} [options.logLevel] - Log level (off, error, warn, info, debug)
 * @returns {function} Async function returning config (for electron-builder)
 */
function createQvacElectronBuilderConfig(options = {}) {
  const {
    appId = "com.example.app",
    productName = "My App",
    extraFiles = [],
    mac = { target: "dmg" },
    win = { target: "nsis" },
    linux = { target: "AppImage" },
    projectDir = process.cwd(),
    strict = false,
    logLevel,
    ...rest
  } = options;

  const baseConfig = {
    appId,
    productName,
    directories: { output: "dist" },
    files: [
      "**/*",
      "!**/node_modules/*/{CHANGELOG.md,README.md,readme.md,README}",
      "!**/node_modules/*/{test,__tests__,tests,example,examples}",
      "!**/node_modules/*.d.ts",
      "!**/node_modules/.bin",
      ...extraFiles,
    ],
    mac,
    win,
    linux,
    ...rest,
  };

  return withQvacElectronBuilder(baseConfig, { projectDir, strict, logLevel });
}

/**
 * Default config for use with "extends" in package.json.
 * Users can do: { "build": { "extends": "@qvac/sdk/electron-builder" } }
 */
const defaultConfig = createQvacElectronBuilderConfig();

module.exports = defaultConfig;
module.exports.default = defaultConfig;
module.exports.withQvacElectronBuilder = withQvacElectronBuilder;
module.exports.createQvacElectronBuilderConfig = createQvacElectronBuilderConfig;
module.exports.prunePrebuildsHook = prunePrebuildsHook;
module.exports.generateAddonExclusions = generateAddonExclusions;
module.exports.discoverQvacAddonPackages = discoverQvacAddonPackages;
module.exports.setLogLevel = setLogLevel;