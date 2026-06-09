/**
 * @qvac/sdk/electron-forge
 *
 * Electron Forge plugin: bundles the QVAC worker, verifies its native addons,
 * then configures Electron Packager to tree-shake unused @qvac/* addons and
 * non-target prebuilds.
 *
 * macOS universal (`arch: "universal"`) is not supported — native addon
 * prebuilds are arch-specific. Build darwin-arm64 and darwin-x64 separately.
 */

"use strict";

const { PluginBase } = require("@electron-forge/plugin-base");
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");

// ============================================
// Errors
// ============================================

/**
 * Plugin-originated error. Stack is trimmed to `name: message` so Forge's
 * "unhandled rejection" block stays focused on the cause.
 */
class QvacForgePluginError extends Error {
  constructor(message) {
    super(message);
    this.name = "QvacForgePluginError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

// ============================================
// Logger
// ============================================

const PREFIX = "[qvac:electron-forge]";

const EXPECTED_FS_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
]);

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
    if (err && EXPECTED_FS_ERROR_CODES.has(err.code)) return;
    this.warn(`Unexpected error in ${context}: ${err?.message || err}`);
  },
};

// ============================================
// SDK Package Resolution (for addon discovery)
// ============================================

const SDK_PACKAGE_NAMES = ["@qvac/sdk"];

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
 * Handles monorepos, workspaces, and hoisted layouts.
 */
function findQvacScopeDir(startDir) {
  const sdkPkg = resolveSDKPackage(startDir);
  if (!sdkPkg) {
    throw new QvacForgePluginError(
      `Could not find QVAC SDK. ` +
        `Ensure one of [${SDK_PACKAGE_NAMES.join(", ")}] is installed.`,
    );
  }

  logger.debug(`Resolved SDK package: ${sdkPkg.name}`);

  const baseDir = path.resolve(startDir);
  const req = createRequire(path.join(baseDir, "package.json"));
  const nodeModulesDirs = req.resolve.paths(sdkPkg.name) || [];

  for (const nodeModulesDir of nodeModulesDirs) {
    const scopeDir = path.join(nodeModulesDir, "@qvac");
    if (isDir(scopeDir)) return scopeDir;
  }

  // Fallback: derive from SDK path for flat node_modules layouts.
  const derived = path.dirname(path.dirname(sdkPkg.path));
  if (path.basename(derived) === "@qvac" && isDir(derived)) return derived;

  throw new QvacForgePluginError(
    `Could not find @qvac packages. ` +
      `Ensure dependencies are installed under node_modules (PnP is not supported).`,
  );
}

/**
 * Discovers installed @qvac addon packages by scanning node_modules/@qvac
 * for packages that have `addon: true` in package.json.
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

    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      if (pkg.addon === true) {
        discovered.push(`@qvac/${name}`);
      }
    } catch (err) {
      logger.warn(`Failed to parse ${pkgJsonPath}: ${err.message}`);
    }
  }

  discovered.sort();
  return discovered;
}

/**
 * Pure diff: addons that are installed but not in the required set.
 * Exposed for unit testing.
 */
function diffAddons(installed, required) {
  const requiredSet = new Set(required);
  const exclusions = [];
  for (const pkg of installed) {
    if (!requiredSet.has(pkg)) exclusions.push(pkg);
  }
  return exclusions;
}

/**
 * Computes the list of installed @qvac addons that aren't in `required`.
 * Logs include/exclude decisions for each discovered package.
 */
function computeExclusions(required, projectDir) {
  const installed = discoverQvacAddonPackages(projectDir);

  if (installed.length === 0) {
    logger.warn(
      "No @qvac addon packages discovered. Skipping addon exclusions.",
    );
    return [];
  }

  const requiredSet = new Set(required);
  const exclusions = [];
  for (const pkg of installed) {
    if (requiredSet.has(pkg)) {
      logger.info(`Including required addon: ${pkg}`);
    } else {
      logger.info(`Excluding unused addon: ${pkg}`);
      exclusions.push(pkg);
    }
  }
  return exclusions;
}

// ============================================
// Ignore Patterns
// ============================================

/** Mobile prebuild patterns to always exclude in desktop builds. */
const MOBILE_PREBUILD_PATTERNS = [
  /[\\/]prebuilds[\\/]android-/,
  /[\\/]prebuilds[\\/]ios-/,
];

/** Forge's default output dir — always exclude to avoid recursive packaging. */
const OUT_DIR_PATTERN = /^\/out\//;

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createAddonIgnorePatterns(exclusions) {
  const patterns = [];
  for (const addon of exclusions) {
    const parts = addon.split("/").map(escapeRegExp);
    patterns.push(
      new RegExp(
        `[\\\\/]node_modules[\\\\/]${parts.join("[\\\\/]")}([\\\\/]|$)`,
      ),
    );
  }
  return patterns;
}

/**
 * Builds an Electron Packager `ignore` value that excludes the given addon
 * packages and mobile prebuilds, while composing with any user-provided
 * ignore (function or regex array).
 */
function createIgnore(exclusions, existingIgnore) {
  const addonIgnorePatterns = createAddonIgnorePatterns(exclusions);

  if (typeof existingIgnore === "function") {
    return (filePath) => {
      if (existingIgnore(filePath)) return true;
      if (OUT_DIR_PATTERN.test(filePath)) return true;
      for (const pattern of addonIgnorePatterns) {
        if (pattern.test(filePath)) return true;
      }
      for (const pattern of MOBILE_PREBUILD_PATTERNS) {
        if (pattern.test(filePath)) return true;
      }
      return false;
    };
  }

  return [
    ...toArray(existingIgnore),
    OUT_DIR_PATTERN,
    ...MOBILE_PREBUILD_PATTERNS,
    ...addonIgnorePatterns,
  ];
}

// ============================================
// Prebuild Pruning
// ============================================

/**
 * Recursively finds all prebuilds directories under a root path, including
 * inside nested node_modules. Nested node_modules show up in real-world npm
 * trees whenever a transitive dep can't be hoisted (e.g. bare-tls under
 * bare-fetch when version constraints conflict). Skipping those misses real
 * cross-platform prebuilds that would otherwise ship in the packaged app.
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
        // Don't recurse into prebuilds — its children are arch-keyed leaves.
        continue;
      }

      walk(fullPath);
    }
  }

  walk(rootPath);
  return results;
}

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

/** Prunes prebuilds for a given path, keeping only target platform-arch. */
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

      // Prefix match catches musl variants etc. (e.g. linux-x64-musl).
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

/**
 * Removes excluded addon directories from the packaged node_modules.
 *
 * Electron Packager's `ignore` filter excludes file contents but leaves the
 * empty parent directory in the output. This sweep removes those shells so
 * the packaged tree matches the manifest exactly. Idempotent.
 */
function removeExcludedAddonDirs(buildPath, exclusions) {
  const nodeModulesPath = path.join(buildPath, "node_modules");

  if (!fs.existsSync(nodeModulesPath)) {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;

  for (const name of exclusions) {
    const pkgDir = path.join(nodeModulesPath, name);
    if (!fs.existsSync(pkgDir)) continue;

    try {
      const size = getDirSize(pkgDir);
      bytes += size;
      fs.rmSync(pkgDir, { recursive: true, force: true });
      removed += 1;
      logger.debug(`Removed excluded addon dir: ${name}`);
    } catch (err) {
      logger.warn(`Failed to remove ${pkgDir}: ${err.message}`);
    }
  }

  return { removed, bytes };
}

// ============================================
// SDK Commands Bridge (CJS plugin → ESM SDK commands)
// ============================================

/**
 * Lazy dynamic-imports `@qvac/sdk/commands`. Plugin file is CJS for Forge's
 * `require()`-based loader; the SDK's commands module is ESM-only via the
 * package's "import" condition. Dynamic `import()` bridges them.
 *
 * @returns {Promise<{
 *   bundleSdk: Function,
 *   verifyBundle: Function,
 *   hasErrors: Function,
 *   formatVerifyBundleResult: Function,
 * }>}
 */
async function loadSdkCommands() {
  try {
    return await import("@qvac/sdk/commands");
  } catch (err) {
    throw new QvacForgePluginError(
      `Could not load @qvac/sdk/commands: ${err?.message || err}. ` +
        `Ensure @qvac/sdk is installed and exposes the ./commands subpath ` +
        `(requires SDK >= 0.12.0).`,
    );
  }
}

/** Defaults to verifying against the host running Forge. */
function defaultHosts() {
  return [`${process.platform}-${process.arch}`];
}

/**
 * Single source of truth for the hosts list used by both bundleSdk and
 * verifyBundle. Keeping these in sync matters: bundleSdk's `hosts` drives
 * the bare-pack content (which prebuilds end up in the bundle), and
 * verifyBundle checks the same set. Passing different lists silently
 * produces inconsistent builds — bundle for one set, verify for another.
 *
 * @param {string[]|null|undefined} explicitHosts
 * @returns {string[]}
 */
function resolveHosts(explicitHosts) {
  return Array.isArray(explicitHosts) && explicitHosts.length > 0
    ? explicitHosts
    : defaultHosts();
}

/**
 * Detects target packaging hosts from Forge config + CLI argv. Returns null
 * when nothing's specified so callers can fall back to defaultHosts().
 *
 * Forge populates packagerConfig from the config file but threads CLI
 * `--platform`/`--arch` separately into Packager — at resolveForgeConfig time
 * argv is the only signal we have. Mirrors checkForUniversalArch's parsing.
 *
 * Comma-separated `--arch=arm64,x64` expands to one host per arch.
 *
 * @param {object} forgeConfig
 * @param {string[]} [argv]  Override for testing (default: process.argv.slice(2)).
 * @returns {string[]|null}
 */
function detectTargetHosts(forgeConfig, argv = process.argv.slice(2)) {
  let platform = forgeConfig?.packagerConfig?.platform || null;
  let archSpec = forgeConfig?.packagerConfig?.arch || null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--platform" || arg === "-p") {
      platform = argv[i + 1] || platform;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--platform=")) {
      platform = arg.slice("--platform=".length) || platform;
      continue;
    }
    if (arg === "--arch" || arg === "-a") {
      archSpec = argv[i + 1] || archSpec;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--arch=")) {
      archSpec = arg.slice("--arch=".length) || archSpec;
    }
  }

  if (!platform && !archSpec) return null;

  const p = platform || process.platform;
  const archs = (archSpec || process.arch)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return archs.length > 0 ? archs.map((a) => `${p}-${a}`) : null;
}

/**
 * Runs `bundleSdk` then `verifyBundle` with the same resolved `hosts` list.
 * Throws QvacForgePluginError on bundle failure or verify errors.
 *
 * Commands are injected (rather than dynamically imported here) so tests
 * can assert the host-list wiring without touching the SDK runtime.
 *
 * @param {{ bundleSdk: Function, verifyBundle: Function, hasErrors: Function, formatVerifyBundleResult: Function }} commands
 * @param {string} projectDir
 * @param {{ configPath?: string|null, hosts?: string[]|null }} options
 * @returns {Promise<{ addons: string[], bundlePath: string, manifestPath: string }>}
 */
async function runBundleAndVerify(commands, projectDir, options) {
  const { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } =
    commands;

  const hosts = resolveHosts(options.hosts);

  logger.info(`Running bundleSdk (hosts: ${hosts.join(", ")})...`);
  let bundleResult;
  try {
    const bundleOpts = { projectRoot: projectDir, hosts };
    if (options.configPath) bundleOpts.configPath = options.configPath;
    bundleResult = await bundleSdk(bundleOpts);
  } catch (err) {
    throw new QvacForgePluginError(
      `bundleSdk failed: ${err?.message || err}`,
    );
  }

  const addonCount = bundleResult.addons.length;
  logger.info(
    `bundleSdk: ${addonCount} native addon${addonCount === 1 ? "" : "s"} in bundle`,
  );

  logger.info(`Running verifyBundle (hosts: ${hosts.join(", ")})...`);
  let verifyResult;
  try {
    const verifyOpts = {
      projectRoot: projectDir,
      addonsSource: bundleResult.bundlePath,
      hosts,
    };
    if (options.configPath) verifyOpts.configPath = options.configPath;
    verifyResult = await verifyBundle(verifyOpts);
  } catch (err) {
    throw new QvacForgePluginError(
      `verifyBundle threw: ${err?.message || err}`,
    );
  }

  if (hasErrors(verifyResult)) {
    throw new QvacForgePluginError(
      `verifyBundle reported errors:\n${formatVerifyBundleResult(verifyResult)}`,
    );
  }

  if (verifyResult.issues.length > 0) {
    logger.warn(
      `verifyBundle produced warnings:\n${formatVerifyBundleResult(verifyResult)}`,
    );
  } else {
    logger.info(
      `verifyBundle: ${verifyResult.addons.length} addon${verifyResult.addons.length === 1 ? "" : "s"} OK`,
    );
  }

  return bundleResult;
}

// ============================================
// QVAC Forge Plugin
// ============================================

class QvacForgePlugin extends PluginBase {
  name = "qvac";

  /**
   * @param {object} [config]
   * @param {string} [config.projectDir]   Project root (default: process.cwd()).
   * @param {string} [config.configPath]   Path to a qvac config file (`.ts`, `.mjs`, `.js`, or `.json`). Forwarded to bundleSdk + verifyBundle. Default: auto-discover in `projectDir`.
   * @param {string[]} [config.hosts]      Hosts to verify against (default: `${process.platform}-${process.arch}`).
   * @param {"off"|"error"|"warn"|"info"|"debug"} [config.logLevel]
   */
  constructor(config = {}) {
    super(config);
    this.projectDir = config.projectDir || process.cwd();
    this.configPath = config.configPath || null;
    this.hosts = Array.isArray(config.hosts) ? config.hosts : null;

    if (config.logLevel) setLogLevel(config.logLevel);

    // Cache for resolveForgeConfig double-fire (package + make).
    this._cache = null;
    this._pruneHook = null;

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

    if (!forgeConfig.packagerConfig) {
      forgeConfig.packagerConfig = {};
    }

    // 1. Block macOS universal builds early.
    this.checkForUniversalArch(forgeConfig);

    // 2. Force asar: false (Bare worker can't load from asar). Truthy check
    //    catches both `asar: true` and `asar: { unpack: ... }` object configs.
    if (forgeConfig.packagerConfig.asar) {
      logger.warn(
        "asar is enabled — Bare worker may fail to load. Overriding to false.",
      );
    }
    forgeConfig.packagerConfig.asar = false;

    // 3. Bundle + verify (cached across resolveForgeConfig invocations).
    //    `hosts` resolution: explicit config wins, then CLI/config-derived
    //    target, then host fallback inside runBundleAndVerify. Hosts are
    //    threaded into BOTH bundleSdk (drives bare-pack content) and
    //    verifyBundle (asserts prebuild availability) — passing different
    //    sets silently produces inconsistent builds.
    if (this._cache === null) {
      const detected = this.hosts ? null : detectTargetHosts(forgeConfig);
      if (detected && !this.hosts) {
        logger.info(`Detected target hosts from CLI/config: ${detected.join(", ")}`);
      }
      const commands = await loadSdkCommands();
      const bundleResult = await runBundleAndVerify(
        commands,
        this.projectDir,
        {
          configPath: this.configPath,
          hosts: this.hosts || detected,
        },
      );
      const exclusions = computeExclusions(
        bundleResult.addons,
        this.projectDir,
      );
      this._cache = { bundleResult, exclusions };
    } else {
      logger.debug("Reusing cached bundleSdk result.");
    }
    const { exclusions } = this._cache;

    // 4. Merge ignore patterns to exclude unused addons + mobile prebuilds.
    const existingIgnore = forgeConfig.packagerConfig.ignore;
    forgeConfig.packagerConfig.ignore = createIgnore(
      exclusions,
      existingIgnore,
    );

    // 5. afterPrune hook for prebuild pruning + excluded addon dir cleanup.
    //    Forge calls resolveForgeConfig multiple times during `make` (once for
    //    `Loading configuration`, then again for `Preparing to package`). We
    //    must not append the hook on each pass, otherwise Packager's afterPrune
    //    fires it N times and we walk the already-pruned tree on every repeat.
    if (this._pruneHook === null) {
      this._pruneHook = this.createPruneHook(exclusions);
    }
    const existingAfterPrune = toArray(forgeConfig.packagerConfig.afterPrune);
    if (!existingAfterPrune.includes(this._pruneHook)) {
      forgeConfig.packagerConfig.afterPrune = [
        ...existingAfterPrune,
        this._pruneHook,
      ];
    }

    logger.debug("Packager configuration complete");
    return forgeConfig;
  }

  /**
   * Blocks macOS universal builds (darwin/universal).
   *
   * Native addon prebuilds are arch-specific (e.g. darwin-arm64 vs
   * darwin-x64) and are not produced as a single "universal" prebuild. A
   * universal Electron app would need to ship both arch prebuild sets,
   * which is incompatible with this plugin's single-arch pruning model.
   * Forge expands universal targets before Packager hooks run, so we must
   * detect it before pruning runs.
   */
  checkForUniversalArch(forgeConfig) {
    const universalMessage =
      `macOS universal packaging is not supported by @qvac/sdk/electron-forge. ` +
      `Native addon prebuilds are architecture-specific and this plugin currently only supports single-arch packaging. ` +
      `Build separate darwin-arm64 and darwin-x64 packages instead.`;

    if (forgeConfig?.packagerConfig?.arch === "universal") {
      throw new QvacForgePluginError(universalMessage);
    }

    const args = process.argv.slice(2);
    let arch = null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];

      if (arg === "--arch" || arg === "-a") {
        arch = args[i + 1] || null;
        continue;
      }

      if (typeof arg === "string" && arg.startsWith("--arch=")) {
        arch = arg.slice("--arch=".length) || null;
        continue;
      }
    }

    if (arch === "universal") {
      throw new QvacForgePluginError(universalMessage);
    }
  }

  createPruneHook(exclusions = []) {
    return (buildPath, electronVersion, platform, arch, done) => {
      logger.info(`Pruning prebuilds for ${platform}-${arch}...`);

      try {
        const prebuildResult = prunePrebuildsForPath(buildPath, platform, arch);
        const prebuildMb = (prebuildResult.bytes / 1024 / 1024).toFixed(1);
        logger.info(
          `Pruned ${prebuildResult.deleted} prebuild dirs (~${prebuildMb} MB reclaimed)`,
        );

        if (exclusions.length > 0) {
          const cleanup = removeExcludedAddonDirs(buildPath, exclusions);
          const cleanupMb = (cleanup.bytes / 1024 / 1024).toFixed(1);
          logger.info(
            `Removed ${cleanup.removed} excluded addon dir${cleanup.removed === 1 ? "" : "s"} (~${cleanupMb} MB reclaimed)`,
          );
        }

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
module.exports.QvacForgePluginError = QvacForgePluginError;

// Internal helpers exposed for unit tests. Not part of the stable API.
module.exports.createIgnore = createIgnore;
module.exports.diffAddons = diffAddons;
module.exports.detectTargetHosts = detectTargetHosts;
module.exports.resolveHosts = resolveHosts;
module.exports.runBundleAndVerify = runBundleAndVerify;
