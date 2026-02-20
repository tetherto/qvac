/**
 * Addon discovery and electron-builder exclusion generation.
 */

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
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

const SDK_PACKAGE_NAMES = ["@qvac/sdk", "@tetherto/sdk-mono"];

/**
 * Resolves the installed SDK package path using Node's module resolution.
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

/**
 * Finds the @qvac scope directory using Node's module resolution paths, which
 * works reliably for monorepos, workspaces, and hoisted node_modules layouts.
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

  const baseDir = path.resolve(startDir);
  try {
    const req = createRequire(path.join(baseDir, "package.json"));
    const nodeModulesDirs = req.resolve.paths(sdkPkg.name) || [];

    for (const nodeModulesDir of nodeModulesDirs) {
      const scopeDir = path.join(nodeModulesDir, "@qvac");
      if (isDir(scopeDir)) return scopeDir;
    }
  } catch (err) {
    logger.debug(
      `Failed to derive node resolution paths for addon discovery: ${err?.message || err}`,
    );
  }

  const derived = path.dirname(path.dirname(sdkPkg.path));
  if (path.basename(derived) === "@qvac" && isDir(derived)) return derived;

  let dir = baseDir;
  while (true) {
    const candidate = path.join(dir, "node_modules", "@qvac");
    if (isDir(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not find @qvac packages. ` +
      `Ensure dependencies are installed under node_modules (PnP is not supported).`,
  );
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
    logger.warn(err?.message || String(err));
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
