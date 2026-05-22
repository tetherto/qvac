import * as fs from "fs";
import * as path from "path";

/**
 * Walks from `startDir` up to the filesystem root, returning the first
 * `<dir>/node_modules/<name>` that exists, or `null`. Matches Node's own
 * module resolution so packages hoisted to a monorepo root (e.g. by bun or
 * yarn workspaces) are found from a nested project directory.
 *
 * Use this as the building block for any plugin lookup that historically
 * checked only `<projectRoot>/node_modules`. For SDK resolution specifically
 * use `resolveSDKPackageDir`, which layers multi-package disambiguation and
 * shadowed-copy warnings on top of this.
 */
function findInAncestorNodeModules(startDir: string, name: string) {
  let dir = startDir;
  let parent = path.dirname(dir);
  for (; dir !== parent; dir = parent, parent = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export { findInAncestorNodeModules };
