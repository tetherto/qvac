/**
 * electron-builder `files` config merging utilities.
 *
 * electron-builder supports multiple `files` formats:
 *   - string: "**\/*"
 *   - string[]: ["**\/*", "!node_modules/foo/**"]
 *   - FileSet: { filter: ["**\/*"], from: ".", to: "." }
 *   - (string | FileSet)[]
 *
 * FileSet objects allow copying from specific directories (e.g., node_modules)
 * with custom filters. When a FileSet has `from: "node_modules"`, exclusion
 * patterns must be rewritten to strip the "node_modules/" prefix since the
 * FileSet's filter is relative to its `from` directory.
 */

/**
 * Checks if a FileSet's `from` field points to node_modules.
 * @param {string|undefined} from
 * @returns {boolean}
 */
function isNodeModulesFrom(from) {
  if (typeof from !== "string") return false;
  const normalized = from.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "node_modules" || normalized.endsWith("/node_modules");
}

/**
 * Rewrites an exclusion pattern for use inside a node_modules FileSet.
 * Strips the "node_modules/" prefix since the FileSet is already rooted there.
 * @param {string} pattern
 * @returns {string}
 */
function rewriteForNodeModulesFileSet(pattern) {
  if (typeof pattern !== "string") return pattern;
  if (pattern.startsWith("!node_modules/")) {
    return "!" + pattern.slice("!node_modules/".length);
  }
  if (pattern.startsWith("node_modules/")) {
    return pattern.slice("node_modules/".length);
  }
  return pattern;
}

/**
 * Normalizes a FileSet filter to an array.
 * @param {string|string[]|undefined} filter
 * @returns {string[]}
 */
function normalizeFilter(filter) {
  if (Array.isArray(filter)) return filter;
  if (typeof filter === "string") return [filter];
  return [];
}

/**
 * Checks if an item is a FileSet object.
 * @param {any} item
 * @returns {boolean}
 */
function isFileSetObject(item) {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

/**
 * Merges QVAC addon exclusions into the user's electron-builder `files` config.
 *
 * @param {string|object|Array} existingFiles - User's files config
 * @param {string[]} exclusions - QVAC exclusion patterns (e.g., "!node_modules/@qvac/tts-onnx/**")
 * @returns {Array} Merged files array
 */
function mergeFilesWithExclusions(existingFiles, exclusions) {
  const filesArray = Array.isArray(existingFiles)
    ? existingFiles
    : [existingFiles];

  const hasFileSetObjects = filesArray.some(isFileSetObject);

  // Fast path: no FileSet objects, just append exclusions
  if (!hasFileSetObjects) {
    return [...filesArray, ...exclusions];
  }

  // FileSet path: need to handle node_modules-rooted FileSets specially
  const nodeModulesExclusions = exclusions.map(rewriteForNodeModulesFileSet);
  let hasStringPatterns = false;

  const result = filesArray.map((item) => {
    if (typeof item === "string") {
      hasStringPatterns = true;
      return item;
    }

    if (!isFileSetObject(item)) {
      return item;
    }

    // For node_modules FileSets, use rewritten exclusions (no prefix)
    const extraPatterns = isNodeModulesFrom(item.from)
      ? nodeModulesExclusions
      : exclusions;

    const hasExplicitFilter = item.filter !== undefined && item.filter !== null;
    const existingFilter = normalizeFilter(item.filter);
    const baseFilter = hasExplicitFilter ? existingFilter : ["**/*"];

    return {
      ...item,
      filter: [...baseFilter, ...extraPatterns],
    };
  });

  // String patterns use the default file matcher; FileSet objects are separate
  // copy operations. If both exist, exclusions must be appended for strings too.
  return hasStringPatterns ? [...result, ...exclusions] : result;
}

module.exports = {
  mergeFilesWithExclusions,
};
