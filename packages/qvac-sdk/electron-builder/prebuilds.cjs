/**
 * Prebuild pruning logic for electron-builder afterPack hook.
 *
 * Removes prebuild directories for platforms/architectures not being built
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("./logger.cjs");

/**
 * Electron arch enum values mapped to architecture names.
 * @see https://www.electron.build/builder-util.typealias.archtype
 */
const ELECTRON_ARCH_MAP = Object.freeze({
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
});

/**
 * Resolves the architecture name from electron-builder's arch value.
 * Handles both string and numeric enum values.
 *
 * @param {string|number} arch - Architecture (string name or numeric enum)
 * @returns {string} Architecture name
 */
function resolveArchName(arch) {
  if (typeof arch === "string") return arch;
  return ELECTRON_ARCH_MAP[arch] || String(arch);
}

/**
 * Finds the app.asar.unpacked directory within the staged app.
 *
 * @param {string} appOutDir - The staged app output directory
 * @param {string} platform - Electron platform name
 * @returns {string|null} Path to app.asar.unpacked, or null if not found
 */
function findUnpackedDir(appOutDir, platform) {
  if (platform === "darwin") {
    // macOS: appOutDir/<AppName>.app/Contents/Resources/app.asar.unpacked
    const appBundles = fs
      .readdirSync(appOutDir)
      .filter((f) => f.endsWith(".app"));
    if (appBundles.length === 0) return null;
    const unpackedPath = path.join(
      appOutDir,
      appBundles[0],
      "Contents",
      "Resources",
      "app.asar.unpacked"
    );
    return fs.existsSync(unpackedPath) ? unpackedPath : null;
  }

  // Windows/Linux: appOutDir/resources/app.asar.unpacked
  const unpackedPath = path.join(appOutDir, "resources", "app.asar.unpacked");
  return fs.existsSync(unpackedPath) ? unpackedPath : null;
}

/**
 * Finds the packaged app directory when asar is disabled.
 *
 * @param {string} appOutDir - The staged app output directory
 * @param {string} platform - Electron platform name
 * @returns {string|null} Path to the app directory, or null if not found
 */
function findAppDir(appOutDir, platform) {
  if (platform === "darwin") {
    // macOS: appOutDir/<AppName>.app/Contents/Resources/app
    const appBundles = fs
      .readdirSync(appOutDir)
      .filter((f) => f.endsWith(".app"));
    if (appBundles.length === 0) return null;
    const appPath = path.join(
      appOutDir,
      appBundles[0],
      "Contents",
      "Resources",
      "app"
    );
    return fs.existsSync(appPath) ? appPath : null;
  }

  // Windows/Linux: appOutDir/resources/app
  const appPath = path.join(appOutDir, "resources", "app");
  return fs.existsSync(appPath) ? appPath : null;
}

/**
 * Finds the node_modules directory in the staged app.
 * Supports both asar (native modules in app.asar.unpacked) and non-asar builds.
 *
 * @param {string} appOutDir - The staged app output directory
 * @param {string} platform - Electron platform name
 * @returns {string|null} Path to node_modules, or null if not found
 */
function findNodeModulesDir(appOutDir, platform) {
  // Check unpacked directory first (asar builds)
  const unpackedDir = findUnpackedDir(appOutDir, platform);
  if (unpackedDir) {
    const nodeModulesPath = path.join(unpackedDir, "node_modules");
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;
  }

  // Check app directory (non-asar builds)
  const appDir = findAppDir(appOutDir, platform);
  if (appDir) {
    const nodeModulesPath = path.join(appDir, "node_modules");
    if (fs.existsSync(nodeModulesPath)) return nodeModulesPath;
  }

  return null;
}

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
        // Descend into node_modules only at root level, or any non-node_modules dir
        walk(fullPath);
      }
    }
  }

  walk(rootPath);
  return results;
}

/**
 * Estimates the size of a directory (rough, for logging).
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
      logger.fsError("getDirSize.walk", err);
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
 * afterPack hook: Prunes unused prebuild directories from the staged app.
 *
 * @param {object} context - electron-builder AfterPackContext
 */
async function prunePrebuildsHook(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const platform = electronPlatformName;
  const archName = resolveArchName(arch);

  logger.info(`Pruning prebuilds for ${platform}-${archName}...`);

  const nodeModulesPath = findNodeModulesDir(appOutDir, platform);
  if (!nodeModulesPath) {
    logger.debug("No packaged node_modules found, skipping prebuild pruning.");
    return;
  }

  // Keep only prebuilds matching target platform-arch (e.g., "darwin-arm64")
  const keepPrefix = `${platform}-${archName}`;
  logger.debug(`Keeping prefix: ${keepPrefix}`);

  const prebuildsDirs = findPrebuildsDirs(nodeModulesPath);

  let totalDeleted = 0;
  let totalBytes = 0;

  for (const prebuildsDir of prebuildsDirs) {
    let entries;
    try {
      entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
    } catch (err) {
      logger.fsError("prunePrebuildsHook", err);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Keep if entry matches target platform-arch (prefix match for musl variants etc.)
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

  const mbSaved = (totalBytes / 1024 / 1024).toFixed(1);
  logger.info(`Pruned ${totalDeleted} prebuild dirs (~${mbSaved} MB reclaimed)`);
}

module.exports = {
  prunePrebuildsHook,
};
