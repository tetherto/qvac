/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

const PACKAGE_ROOT = path.join(__dirname, "..");
const PREBUILDS_DIR_NAME = "prebuilds";
const PLATFORM_ADDON_DIR_NAME = "addon";
const PLATFORM_PACKAGE_PREFIX = "@qvac/asr-ggml-";
const PLATFORM_MANIFEST_SUBPATH = "/package";
const IOS_PLATFORM = "ios";
const HOST_SEPARATOR = "-";

export const PREBUILT_HOSTS = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
];

export interface BackendsDirSources {
  localPrebuildsDir: string;
  host: string | null;
  directoryExists: (dir: string) => boolean;
  resolveManifest: (specifier: string) => string | null;
}

export function hostPlatformPackage(host: string): string {
  const platform = host.split(HOST_SEPARATOR)[0];
  const suffix = platform === IOS_PLATFORM ? IOS_PLATFORM : host;
  return PLATFORM_PACKAGE_PREFIX + suffix;
}

export function resolveBackendsDirFrom(sources: BackendsDirSources): string {
  if (sources.directoryExists(sources.localPrebuildsDir)) {
    return sources.localPrebuildsDir;
  }
  return platformPackagePrebuildsDir(sources) ?? sources.localPrebuildsDir;
}

function platformPackagePrebuildsDir(
  sources: BackendsDirSources,
): string | null {
  if (!sources.host) {
    return null;
  }
  const manifestPath = sources.resolveManifest(
    hostPlatformPackage(sources.host) + PLATFORM_MANIFEST_SUBPATH,
  );
  if (!manifestPath) {
    return null;
  }
  return path.join(
    path.dirname(manifestPath),
    PLATFORM_ADDON_DIR_NAME,
    PREBUILDS_DIR_NAME,
  );
}

export function resolveBackendsDir(): string {
  return resolveBackendsDirFrom({
    localPrebuildsDir: path.join(PACKAGE_ROOT, PREBUILDS_DIR_NAME),
    host: currentHost(),
    directoryExists: safeDirectoryExists,
    resolveManifest: safeResolveManifest,
  });
}

function currentHost(): string | null {
  return require.addon ? require.addon.host : null;
}

function safeDirectoryExists(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

function safeResolveManifest(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}
