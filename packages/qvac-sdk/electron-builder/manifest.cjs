/**
 * Addons manifest reader.
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("./logger.cjs");

/**
 * Reads qvac/addons.manifest.json from the project directory.
 *
 * @param {string} projectDir - Project root directory
 * @param {boolean} strict - If true, throws on missing/invalid manifest
 * @returns {Set<string>|null} Set of required addon names, or null if manifest not found
 */
function readManifest(projectDir, strict = false) {
  const manifestPath = path.join(projectDir, "qvac", "addons.manifest.json");

  if (!fs.existsSync(manifestPath)) {
    const msg =
      "No qvac/addons.manifest.json found. " +
      "Run 'npx qvac bundle sdk' first to generate it.";
    if (strict) {
      throw new Error(msg);
    }
    logger.warn(msg);
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return new Set(manifest.addons || []);
  } catch (err) {
    const msg = `Failed to parse addons.manifest.json: ${err.message}`;
    if (strict) {
      throw new Error(msg);
    }
    logger.error(msg);
    return null;
  }
}

module.exports = {
  readManifest,
};
