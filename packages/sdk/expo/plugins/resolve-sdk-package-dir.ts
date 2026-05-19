import * as fs from "fs";
import * as path from "path";
import {
  SDKNotFoundInNodeModulesError,
  MultipleSDKInstallationsError,
} from "@/utils/errors-client";

const SDK_PACKAGE_NAMES = [
  "@qvac/sdk",
  "@tetherto/sdk-mono",
  "@tetherto/sdk-dev",
];

type SDKPackageInfo = {
  dir: string;
  name: string;
};

function findInAncestorNodeModules(startDir: string, name: string): string | null {
  let dir = startDir;
  let parent = path.dirname(dir);
  for (; dir !== parent; dir = parent, parent = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves the installed SDK package directory from node_modules.
 *
 * Checks all known published package names and returns the one that exists.
 * Throws if none found or if multiple are found (ambiguous installation).
 *
 * Walks up the directory tree from projectRoot so packages hoisted to a
 * monorepo root (e.g. by bun or yarn workspaces) are found correctly.
 */
function resolveSDKPackageDir(projectRoot: string): SDKPackageInfo {
  const found: SDKPackageInfo[] = [];

  for (const name of SDK_PACKAGE_NAMES) {
    const dir = findInAncestorNodeModules(projectRoot, name);
    if (dir !== null) {
      found.push({ name, dir });
      console.debug(`[resolveSDKPackageDir] resolved "${name}" at "${dir}"`);
    } else {
      console.debug(
        `[resolveSDKPackageDir] could not find "${name}" in any node_modules from "${projectRoot}" upward`,
      );
    }
  }

  if (found.length === 0) {
    throw new SDKNotFoundInNodeModulesError();
  }

  if (found.length > 1) {
    throw new MultipleSDKInstallationsError(
      found.map((f) => f.name).join(", "),
    );
  }

  return found[0]!;
}

export { resolveSDKPackageDir, SDK_PACKAGE_NAMES };
export type { SDKPackageInfo };
