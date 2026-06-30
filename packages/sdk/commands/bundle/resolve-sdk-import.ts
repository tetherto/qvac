import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type SdkExportEntry = string | { [condition: string]: SdkExportEntry };

const SDK_EXPORT_CONDITIONS = [
  "bare",
  "import",
  "module",
  "default",
  "node",
  "require",
];

export function selectExportTarget(
  entry: SdkExportEntry | undefined,
): string | null {
  if (entry == null) return null;
  if (typeof entry === "string") return entry;
  for (const condition of SDK_EXPORT_CONDITIONS) {
    const resolved = selectExportTarget(entry[condition]);
    if (resolved) return resolved;
  }
  return null;
}

function readSdkExports(sdkPath: string): Record<string, SdkExportEntry> {
  try {
    const raw = fs.readFileSync(path.join(sdkPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      exports?: Record<string, SdkExportEntry>;
    };
    return pkg.exports ?? {};
  } catch {
    return {};
  }
}

// bare-pack rewrites the worker's Node builtins to their bare-* equivalents
// (os -> bare-os, fs -> bare-fs, ...) and resolves them relative to wherever
// the generated entry imports the SDK from. A bare specifier resolves against
// the consumer project, so a hoisted/symlinked SDK (pnpm, workspaces) whose
// bare-* deps live in a parent node_modules becomes unreachable. Importing each
// SDK subpath via its resolved file under the SDK's realpath anchors that
// resolution next to the bare-* deps instead.
export function createSdkImportResolver(
  sdkPath: string,
  sdkName: string,
): (specifier: string) => string {
  let resolvedSdkPath = sdkPath;
  try {
    resolvedSdkPath = fs.realpathSync(sdkPath);
  } catch {
    // Keep sdkPath as-is if it cannot be canonicalized.
  }
  const exportsMap = readSdkExports(resolvedSdkPath);
  const prefix = `${sdkName}/`;
  return (specifier) => {
    if (!specifier.startsWith(prefix)) return specifier;
    const subpath = `./${specifier.slice(prefix.length)}`;
    const target = selectExportTarget(exportsMap[subpath]);
    if (!target) return specifier;
    return pathToFileURL(path.join(resolvedSdkPath, target)).href;
  };
}
