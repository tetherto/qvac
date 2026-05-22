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

type SDKMatch = SDKPackageInfo & {
  depth: number;
};

function findAllInAncestorNodeModules(startDir: string, name: string) {
  const matches: SDKMatch[] = [];
  let dir = startDir;
  let parent = path.dirname(dir);
  let depth = 0;
  for (; dir !== parent; dir = parent, parent = path.dirname(dir), depth++) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(candidate)) {
      matches.push({ name, dir: candidate, depth });
    }
  }
  return matches;
}

/**
 * Resolves the installed SDK package directory from node_modules.
 *
 * Walks from `projectRoot` up to the filesystem root, checking each
 * `node_modules` directory along the way. This matches Node's own module
 * resolution so packages hoisted to a monorepo root (e.g. by bun or yarn
 * workspaces) are found correctly.
 *
 * When multiple SDK installs are found across the tree, the one closest to
 * `projectRoot` wins and a warning lists the others. Only throws
 * `MultipleSDKInstallationsError` when two *different* SDK package names
 * coexist at the same nesting level (a real ambiguity in package selection).
 */
function resolveSDKPackageDir(projectRoot: string): SDKPackageInfo {
  const allMatches: SDKMatch[] = [];
  for (const name of SDK_PACKAGE_NAMES) {
    allMatches.push(...findAllInAncestorNodeModules(projectRoot, name));
  }

  if (allMatches.length === 0) {
    throw new SDKNotFoundInNodeModulesError();
  }

  const minDepth = Math.min(...allMatches.map((m) => m.depth));
  const closest = allMatches.filter((m) => m.depth === minDepth);

  if (closest.length > 1) {
    throw new MultipleSDKInstallationsError(
      closest.map((m) => m.name).join(", "),
    );
  }

  const winner = closest[0]!;
  const shadowed = allMatches.filter((m) => m !== winner);
  if (shadowed.length > 0) {
    const others = shadowed.map((m) => `"${m.name}" at "${m.dir}"`).join(", ");
    console.warn(
      `[resolveSDKPackageDir] Multiple SDK installations found; using ` +
        `"${winner.name}" at "${winner.dir}" (closest to projectRoot). ` +
        `Ignoring: ${others}.`,
    );
  }

  return { name: winner.name, dir: winner.dir };
}

export { resolveSDKPackageDir, SDK_PACKAGE_NAMES };
export type { SDKPackageInfo };
