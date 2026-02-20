/**
 * @qvac/sdk/electron-forge
 *
 * Electron Forge plugin for QVAC SDK.
 * Provides automatic native addon tree-shaking and prebuild pruning.
 *
 * Usage:
 *   // forge.config.cjs
 *   const QvacForgePlugin = require("@qvac/sdk/electron-forge");
 *
 *   module.exports = {
 *     plugins: [new QvacForgePlugin()],
 *     makers: [...],
 *   };
 *
 *   // With options:
 *   new QvacForgePlugin({ logLevel: "debug" })
 *
 * Options:
 *   - logLevel: "off" | "error" | "warn" | "info" | "debug"
 *   - strict: boolean - throws on missing manifest instead of warning
 *   - projectDir: string - override project root directory
 *
 * What it does automatically:
 *   1. Excludes unused @qvac addon packages based on qvac/addons.manifest.json
 *   2. Prunes non-target platform prebuilds after packaging
 *   3. Ensures asar: false (Forge default; required for Bare worker)
 */

"use strict";

const { PluginBase } = require("@electron-forge/plugin-base");
const path = require("path");
const fs = require("fs");

// ============================================
// Logger
// ============================================

const PREFIX = "[qvac:electron-forge]";

const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function getDefaultLevel() {
  const level = process.env.QVAC_LOG_LEVEL?.toLowerCase();
  return level && level in LOG_LEVELS ? level : "info";
}

let currentLevel = LOG_LEVELS[getDefaultLevel()];

function setLogLevel(level) {
  if (!(level in LOG_LEVELS)) {
    console.warn(
      `${PREFIX} Invalid log level "${level}", using "info". Valid: ${Object.keys(LOG_LEVELS).join(", ")}`,
    );
    currentLevel = LOG_LEVELS.info;
    return;
  }
  currentLevel = LOG_LEVELS[level];
}

const logger = {
  error(msg) {
    if (currentLevel >= LOG_LEVELS.error) console.error(PREFIX, msg);
  },
  warn(msg) {
    if (currentLevel >= LOG_LEVELS.warn) console.warn(PREFIX, msg);
  },
  info(msg) {
    if (currentLevel >= LOG_LEVELS.info) console.log(PREFIX, msg);
  },
  debug(msg) {
    if (currentLevel >= LOG_LEVELS.debug) console.log(PREFIX, msg);
  },
  fsError(context, err) {
    const EXPECTED_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
    if (err && EXPECTED_CODES.has(err.code)) return;
    this.warn(`Unexpected error in ${context}: ${err?.message || err}`);
  },
};

// ============================================
// Manifest Reader
// ============================================

/**
 * Reads qvac/addons.manifest.json from the project directory.
 *
 * @param {string} projectDir - Project root directory
 * @param {boolean} strict - If true, throws on missing/invalid manifest
 * @returns {Set<string>|null} Set of required addon names, or null if not found
 */
function readManifest(projectDir, strict = false) {
  const manifestPath = path.join(projectDir, "qvac", "addons.manifest.json");

  if (!fs.existsSync(manifestPath)) {
    const msg =
      "No qvac/addons.manifest.json found. Run 'npx qvac bundle sdk' first.";
    if (strict) throw new Error(msg);
    logger.warn(msg);
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return new Set(manifest.addons || []);
  } catch (err) {
    const msg = `Failed to parse addons.manifest.json: ${err.message}`;
    if (strict) throw new Error(msg);
    logger.error(msg);
    return null;
  }
}

// ============================================
// SDK Package Resolution
// ============================================

const SDK_PACKAGE_NAMES = ["@qvac/sdk", "@tetherto/sdk-mono"];

/**
 * Resolves the SDK package entry point using Node's module resolution.
 * Tries each known package name in order.
 *
 * @param {string} startDir - Directory to start resolution from
 * @returns {{ name: string, path: string }|null} Package info or null if not found
 */
function resolveSDKPackage(startDir) {
  for (const name of SDK_PACKAGE_NAMES) {
    try {
      const pkgPath = require.resolve(`${name}/package`, { paths: [startDir] });
      return { name, path: pkgPath };
    } catch {
      // Try next package name
    }
  }
  return null;
}

// ============================================
// Addon Discovery
// ============================================

/**
 * Mobile prebuild patterns to always exclude in desktop builds.
 */
const MOBILE_PREBUILD_PATTERNS = [
  /[\\/]prebuilds[\\/]android-/,
  /[\\/]prebuilds[\\/]ios-/,
];

function isDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (err) {
    logger.fsError("isDir", err);
    return false;
  }
}

/**
 * Finds the @qvac scope directory using Node's module resolution.
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {string} Path to node_modules/@qvac
 * @throws {Error} If @qvac scope directory cannot be found
 */
function findQvacScopeDir(startDir) {
  const sdkPkg = resolveSDKPackage(startDir);
  if (!sdkPkg) {
    throw new Error(
      `Could not find QVAC SDK. ` +
        `Ensure one of [${SDK_PACKAGE_NAMES.join(", ")}] is installed.`,
    );
  }

  logger.debug(`Resolved SDK package: ${sdkPkg.name}`);
  return path.dirname(path.dirname(sdkPkg.path));
}

/**
 * Discovers installed @qvac addon packages by scanning node_modules/@qvac
 * for packages that have `addon: true` in package.json.
 *
 * @param {string} projectDir - Project root directory
 * @returns {string[]} Array of package names like "@qvac/llm-llamacpp"
 */
function discoverQvacAddonPackages(projectDir) {
  let scopeDir;
  try {
    scopeDir = findQvacScopeDir(projectDir);
  } catch (err) {
    logger.warn(err.message);
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(scopeDir);
  } catch (err) {
    logger.fsError("discoverQvacAddonPackages", err);
    return [];
  }

  const discovered = [];

  for (const name of entries) {
    const pkgDir = path.join(scopeDir, name);
    if (!isDir(pkgDir)) continue;

    let isAddon = false;

    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        isAddon = pkg.addon === true;
      } catch (err) {
        logger.warn(`Failed to parse ${pkgJsonPath}: ${err.message}`);
      }
    }

    if (isAddon) {
      discovered.push(`@qvac/${name}`);
    }
  }

  discovered.sort();
  return discovered;
}

/**
 * Generates list of @qvac addon packages to exclude.
 *
 * @param {string} projectDir - Project root directory
 * @param {boolean} strict - If true, throws on missing manifest
 * @returns {string[]} Array of package names to exclude
 */
function generateExclusionList(projectDir, strict = false) {
  const requiredAddons = readManifest(projectDir, strict);
  const exclusions = [];

  if (requiredAddons) {
    const addonPackages = discoverQvacAddonPackages(projectDir);

    if (addonPackages.length === 0) {
      logger.warn(
        "No @qvac addon packages discovered. Skipping addon exclusions.",
      );
    }

    for (const pkg of addonPackages) {
      if (!requiredAddons.has(pkg)) {
        exclusions.push(pkg);
        logger.info(`Excluding unused addon: ${pkg}`);
      } else {
        logger.info(`Including required addon: ${pkg}`);
      }
    }
  }

  return exclusions;
}

// ============================================
// Prebuild Pruning
// ============================================

/**
 * Recursively finds all prebuilds directories under a root path.
 *
 * @param {string} rootPath - Root directory to search
 * @returns {string[]} Array of absolute paths to prebuilds directories
 */
function findPrebuildsDirs(rootPath) {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.fsError("findPrebuildsDirs", err);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.name === "prebuilds") {
        results.push(fullPath);
      } else if (entry.name !== "node_modules" || dir === rootPath) {
        walk(fullPath);
      }
    }
  }

  walk(rootPath);
  return results;
}

/**
 * Estimates the size of a directory.
 *
 * @param {string} dirPath - Directory path
 * @returns {number} Size in bytes
 */
function getDirSize(dirPath) {
  let size = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.fsError("getDirSize", err);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        try {
          size += fs.statSync(fullPath).size;
        } catch (err) {
          logger.fsError("getDirSize.stat", err);
        }
      }
    }
  }

  walk(dirPath);
  return size;
}

/**
 * Prunes prebuilds for a given path, keeping only target platform-arch.
 *
 * @param {string} buildPath - Path to the app directory containing node_modules
 * @param {string} platform - Target platform (darwin, win32, linux)
 * @param {string} arch - Target architecture (arm64, x64, etc.)
 * @returns {{ deleted: number, bytes: number }}
 */
function prunePrebuildsForPath(buildPath, platform, arch) {
  const nodeModulesPath = path.join(buildPath, "node_modules");

  if (!fs.existsSync(nodeModulesPath)) {
    logger.debug("No node_modules found, skipping prebuild pruning.");
    return { deleted: 0, bytes: 0 };
  }

  const keepPrefix = `${platform}-${arch}`;
  logger.debug(`Keeping prefix: ${keepPrefix}`);

  const prebuildsDirs = findPrebuildsDirs(nodeModulesPath);
  let totalDeleted = 0;
  let totalBytes = 0;

  for (const prebuildsDir of prebuildsDirs) {
    let entries;
    try {
      entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
    } catch (err) {
      logger.fsError("prunePrebuildsForPath", err);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Keep if entry matches target platform-arch (prefix match for musl variants)
      const shouldKeep = entry.name.startsWith(keepPrefix);

      if (!shouldKeep) {
        const fullPath = path.join(prebuildsDir, entry.name);
        try {
          const size = getDirSize(fullPath);
          totalBytes += size;
          fs.rmSync(fullPath, { recursive: true, force: true });
          totalDeleted++;
          logger.debug(`Deleted: ${entry.name}`);
        } catch (err) {
          logger.warn(`Failed to delete ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  return { deleted: totalDeleted, bytes: totalBytes };
}

// ============================================
// QVAC Forge Plugin
// ============================================

class QvacForgePlugin extends PluginBase {
  name = "qvac";

  constructor(config = {}) {
    super(config);
    this.projectDir = config.projectDir || process.cwd();
    this.strict = config.strict || false;

    if (config.logLevel) {
      setLogLevel(config.logLevel);
    }

    logger.debug("QvacForgePlugin initialized");
    logger.debug(`Project directory: ${this.projectDir}`);
  }

  getHooks() {
    return {
      resolveForgeConfig: this.configurePackager.bind(this),
    };
  }

  async configurePackager(forgeConfig) {
    logger.info("Configuring packager for QVAC...");

    // Ensure packagerConfig exists
    if (!forgeConfig.packagerConfig) {
      forgeConfig.packagerConfig = {};
    }

    // 1. Set asar: false (Bare worker can't load from asar)
    if (forgeConfig.packagerConfig.asar === true) {
      logger.warn(
        "asar is enabled — Bare worker may fail to load. Overriding to false.",
      );
    }
    forgeConfig.packagerConfig.asar = false;

    // 2. Generate exclusion list for unused addons
    const exclusions = generateExclusionList(this.projectDir, this.strict);

    // 3. Create ignore function
    const existingIgnore = forgeConfig.packagerConfig.ignore;
    forgeConfig.packagerConfig.ignore = this.createIgnoreFunction(
      exclusions,
      existingIgnore,
    );

    // 4. Add afterPrune hook for prebuild pruning
    const existingAfterPrune = forgeConfig.packagerConfig.afterPrune || [];
    forgeConfig.packagerConfig.afterPrune = [
      ...existingAfterPrune,
      this.createPruneHook(),
    ];

    logger.debug("Packager configuration complete");
    return forgeConfig;
  }

  createIgnoreFunction(exclusions, existingIgnore) {
    return (filePath) => {
      // Check existing ignore first
      if (existingIgnore) {
        if (typeof existingIgnore === "function" && existingIgnore(filePath)) {
          return true;
        }
        if (existingIgnore instanceof RegExp && existingIgnore.test(filePath)) {
          return true;
        }
        if (Array.isArray(existingIgnore)) {
          for (const pattern of existingIgnore) {
            if (pattern instanceof RegExp && pattern.test(filePath))
              return true;
            if (typeof pattern === "string" && filePath.includes(pattern))
              return true;
          }
        }
      }

      // Check @qvac addon exclusions
      for (const addon of exclusions) {
        // Match paths like /node_modules/@qvac/embed-llamacpp/
        if (
          filePath.includes(`/node_modules/${addon}/`) ||
          filePath.includes(`\\node_modules\\${addon}\\`)
        ) {
          return true;
        }
      }

      // Always exclude mobile prebuilds in desktop builds
      for (const pattern of MOBILE_PREBUILD_PATTERNS) {
        if (pattern.test(filePath)) {
          return true;
        }
      }

      return false;
    };
  }

  createPruneHook() {
    return (buildPath, electronVersion, platform, arch, done) => {
      logger.info(`Pruning prebuilds for ${platform}-${arch}...`);

      try {
        const result = prunePrebuildsForPath(buildPath, platform, arch);
        const mbSaved = (result.bytes / 1024 / 1024).toFixed(1);
        logger.info(
          `Pruned ${result.deleted} prebuild dirs (~${mbSaved} MB reclaimed)`,
        );
        done();
      } catch (err) {
        logger.error(`Prebuild pruning failed: ${err.message}`);
        done(err);
      }
    };
  }
}

// ============================================
// Exports
// ============================================

module.exports = QvacForgePlugin;
module.exports.setLogLevel = setLogLevel;
