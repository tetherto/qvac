/**
 * Addon discovery and electron-builder exclusion generation.
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("./logger.cjs");
const { readManifest } = require("./manifest.cjs");

function isDir(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (err) {
    logger.fsError("isDir", err);
    return false;
  }
}

/**
 * Mobile platforms to always exclude
 */
const MOBILE_PREBUILD_PATTERNS = [
  "!**/prebuilds/android-*/**/*",
  "!**/prebuilds/ios-*/**/*",
];

/**
 * Finds the @qvac scope directory using Node's module resolution,
 * with a fallback to walking up the directory tree.
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {string} Path to node_modules/@qvac
 * @throws {Error} If @qvac scope directory cannot be found
 */
function findQvacScopeDir(startDir) {
  try {
    const sdkPkgPath = require.resolve("@qvac/sdk/package", {
      paths: [startDir],
    });
    return path.dirname(path.dirname(sdkPkgPath));
  } catch {
    let dir = path.resolve(startDir);
    while (true) {
      const candidate = path.join(dir, "node_modules", "@qvac");
      if (isDir(candidate)) return candidate;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    throw new Error(
      `Could not find @qvac packages. ` +
      `Ensure @qvac/sdk is installed in "${startDir}" or a parent directory.`
    );
  }
}

/**
 * Discovers installed @qvac addon packages by scanning node_modules/@qvac
 * for packages that have `addon: true` in package.json.
 *
 * @param {string} projectDir - Project root directory
 * @returns {string[]} Array of package names like "@qvac/llm-llamacpp"
 */
function discoverQvacAddonPackages(projectDir) {
  const scopeDir = findQvacScopeDir(projectDir);

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
 * Generates file exclusion patterns for unused @qvac addon packages.
 *
 * @param {string} projectDir - Project root directory
 * @param {boolean} strict - If true, throws on missing/invalid manifest
 * @returns {string[]} Array of exclusion patterns for electron-builder files config
 */
function generateAddonExclusions(projectDir, strict = false) {
  const requiredAddons = readManifest(projectDir, strict);
  const exclusions = [];

  if (requiredAddons) {
    const addonPackages = discoverQvacAddonPackages(projectDir);

    if (addonPackages.length === 0) {
      logger.warn(
        "No @qvac addon packages discovered under node_modules/@qvac. " +
        "Skipping @qvac addon package exclusions."
      );
    }

    for (const pkg of addonPackages) {
      if (!requiredAddons.has(pkg)) {
        exclusions.push(`!node_modules/${pkg}/**/*`);
        logger.info(`Excluding unused addon: ${pkg}`);
      } else {
        logger.info(`Including required addon: ${pkg}`);
      }
    }
  }

  // Always exclude mobile prebuilds for desktop apps
  logger.debug("Excluding mobile prebuilds (android-*, ios-*)");
  exclusions.push(...MOBILE_PREBUILD_PATTERNS);

  return exclusions;
}

module.exports = {
  discoverQvacAddonPackages,
  generateAddonExclusions,
};
