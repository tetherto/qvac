import { promises as fsp } from "node:fs";
import path from "node:path";

export type AddonSourceKind = "bare-pack-bundle" | "node-modules";

export interface NativeAddon {
  name: string;
  version?: string;
  packageJsonPath: string;
  packageRoot: string;
  enginesBare?: string;
}

export interface AddonPackageJson {
  name?: string;
  version?: string;
  addon?: boolean;
  engines?: {
    bare?: string;
  };
}

export interface ReadAddonPackageJsonOptions {
  packageJsonPath: string;
  expectedName?: string;
}

export interface InvalidPackageJsonRecord {
  packageJsonPath: string;
  expectedName?: string;
  reason: string;
}

export interface ReadAddonPackageJsonResult {
  found: boolean;
  isAddon: boolean;
  invalid?: InvalidPackageJsonRecord;
  addon?: NativeAddon;
}

export async function readAddonPackageJson(
  options: ReadAddonPackageJsonOptions,
): Promise<ReadAddonPackageJsonResult> {
  const { packageJsonPath, expectedName } = options;
  let raw: string;
  try {
    raw = await fsp.readFile(packageJsonPath, "utf8");
  } catch {
    return { found: false, isAddon: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      found: true,
      isAddon: false,
      invalid: buildInvalid(
        packageJsonPath,
        expectedName,
        `malformed JSON: ${reason}`,
      ),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      found: true,
      isAddon: false,
      invalid: buildInvalid(
        packageJsonPath,
        expectedName,
        "package.json is not a JSON object",
      ),
    };
  }

  const pkg = parsed as AddonPackageJson;
  if (pkg.addon !== true) {
    return { found: true, isAddon: false };
  }

  const name = pkg.name ?? expectedName;
  if (!name) {
    return {
      found: true,
      isAddon: false,
      invalid: buildInvalid(
        packageJsonPath,
        expectedName,
        "addon package.json is missing a `name` field",
      ),
    };
  }

  const addon: NativeAddon = {
    name,
    packageJsonPath,
    packageRoot: path.dirname(packageJsonPath),
  };
  if (typeof pkg.version === "string") addon.version = pkg.version;
  if (typeof pkg.engines?.bare === "string") addon.enginesBare = pkg.engines.bare;

  return { found: true, isAddon: true, addon };
}

function buildInvalid(
  packageJsonPath: string,
  expectedName: string | undefined,
  reason: string,
): InvalidPackageJsonRecord {
  const record: InvalidPackageJsonRecord = { packageJsonPath, reason };
  if (expectedName !== undefined) record.expectedName = expectedName;
  return record;
}

export interface CollectDiagnostics {
  invalidPackageJsons: InvalidPackageJsonRecord[];
  emptyResolutions: boolean;
}

export function createCollectDiagnostics(): CollectDiagnostics {
  return { invalidPackageJsons: [], emptyResolutions: false };
}

export function formatAddonId(addon: {
  name: string;
  version?: string;
}): string {
  return `${addon.name}@${addon.version ?? "unknown"}`;
}

export function deduplicateAddons(addons: NativeAddon[]): NativeAddon[] {
  const byKey = new Map<string, NativeAddon>();
  for (const addon of addons) {
    const key = `${addon.name}@${addon.version ?? "unknown"}::${addon.packageRoot}`;
    if (!byKey.has(key)) byKey.set(key, addon);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      formatAddonId(a).localeCompare(formatAddonId(b)) ||
      a.packageRoot.localeCompare(b.packageRoot),
  );
}
