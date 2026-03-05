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

/**
 * Resolves the installed SDK package directory from node_modules.
 *
 * Checks all known published package names and returns the one that exists.
 * Throws if none found or if multiple are found (ambiguous installation).
 */
function resolveSDKPackageDir(projectRoot: string): SDKPackageInfo {
  const found: SDKPackageInfo[] = [];

  for (const name of SDK_PACKAGE_NAMES) {
    const dir = path.join(projectRoot, "node_modules", name);
    if (fs.existsSync(dir)) {
      found.push({ name, dir });
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
