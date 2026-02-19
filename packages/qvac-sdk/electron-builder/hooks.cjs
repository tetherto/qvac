/**
 * electron-builder hook helpers (afterPack merging and module resolution).
 */

const path = require("path");
const { pathToFileURL } = require("url");
const { logger } = require("./logger.cjs");
const { prunePrebuildsHook } = require("./prebuilds.cjs");

/**
 * Extracts the hook function from a loaded module.
 * Supports: direct function export, default export, or named `afterPack` export.
 *
 * @param {any} hookModule - The loaded module
 * @returns {function|undefined} The hook function, or undefined if not found
 */
function getAfterPackHookFromModule(hookModule) {
  if (typeof hookModule === "function") return hookModule;

  if (!hookModule || typeof hookModule !== "object") {
    return undefined;
  }

  if (typeof hookModule.default === "function") return hookModule.default;
  if (typeof hookModule.afterPack === "function") return hookModule.afterPack;

  return undefined;
}

/**
 * Resolves an afterPack hook from a file path string.
 * Supports both CommonJS and ESM modules.
 *
 * @param {string} hookPath - Path to the hook module
 * @param {string} projectDir - Project root for relative path resolution
 * @returns {Promise<function>} The resolved hook function
 * @throws {Error} If the module cannot be loaded or doesn't export a function
 */
async function resolveAfterPackFromString(hookPath, projectDir) {
  const resolvedPath = path.isAbsolute(hookPath)
    ? hookPath
    : path.resolve(projectDir, hookPath);

  // Prefer CJS require, but fall back to ESM import() if needed
  try {
    const hookModule = require(resolvedPath);
    const hook = getAfterPackHookFromModule(hookModule);
    if (typeof hook === "function") return hook;
    throw new Error(
      `afterPack hook module did not export a function: "${resolvedPath}"`
    );
  } catch (err) {
    if (err?.code !== "ERR_REQUIRE_ESM") {
      throw new Error(
        `Failed to load afterPack hook from "${resolvedPath}": ${err?.message || err}`
      );
    }

    logger.debug(`CJS require failed for "${resolvedPath}", trying ESM import`);
  }

  // ESM fallback
  try {
    const hookModule = await import(pathToFileURL(resolvedPath).href);
    const hook = getAfterPackHookFromModule(hookModule);
    if (typeof hook === "function") return hook;
    throw new Error(
      `afterPack hook module did not export a function: "${resolvedPath}"`
    );
  } catch (err) {
    const msg = err?.message || String(err);
    throw new Error(
      `Failed to import afterPack hook from "${resolvedPath}": ${msg}`
    );
  }
}

/**
 * Creates a merged afterPack hook that runs QVAC pruning first,
 * then the user's hook (if any).
 *
 * Supports:
 * - function: direct hook function
 * - string: path to hook module (resolved from projectDir)
 * - undefined: no user hook
 *
 * @param {function|string|undefined} existingAfterPack - User's afterPack config
 * @param {string} projectDir - Project root for path resolution
 * @returns {function} Merged afterPack hook
 */
function createMergedAfterPackHook(existingAfterPack, projectDir) {
  let userHookPromise;

  return async (ctx) => {
    // Always run QVAC prebuild pruning first
    await prunePrebuildsHook(ctx);

    // Then run user's hook if provided
    if (typeof existingAfterPack === "function") {
      await existingAfterPack(ctx);
    } else if (typeof existingAfterPack === "string") {
      // Lazy-load user's hook module (cached after first load)
      if (!userHookPromise) {
        userHookPromise = resolveAfterPackFromString(
          existingAfterPack,
          projectDir
        );
      }
      const userHook = await userHookPromise;
      await userHook(ctx);
    }
  };
}

module.exports = {
  createMergedAfterPackHook,
};
