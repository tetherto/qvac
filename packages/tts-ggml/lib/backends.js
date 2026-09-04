"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREBUILT_HOSTS = void 0;
exports.hostPlatformPackage = hostPlatformPackage;
exports.resolveBackendsDirFrom = resolveBackendsDirFrom;
exports.resolveBackendsDir = resolveBackendsDir;
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
const fs = require("bare-fs");
const path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
const PACKAGE_ROOT = path.join(__dirname, "..");
const PREBUILDS_DIR_NAME = "prebuilds";
const PLATFORM_ADDON_DIR_NAME = "addon";
const PLATFORM_PACKAGE_PREFIX = "@qvac/tts-ggml-";
const PLATFORM_MANIFEST_SUBPATH = "/package";
const IOS_PLATFORM = "ios";
const HOST_SEPARATOR = "-";
exports.PREBUILT_HOSTS = [
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
function hostPlatformPackage(host) {
    const platform = host.split(HOST_SEPARATOR)[0];
    const suffix = platform === IOS_PLATFORM ? IOS_PLATFORM : host;
    return PLATFORM_PACKAGE_PREFIX + suffix;
}
function resolveBackendsDirFrom(sources) {
    if (sources.directoryExists(sources.localPrebuildsDir)) {
        return sources.localPrebuildsDir;
    }
    return platformPackagePrebuildsDir(sources) ?? sources.localPrebuildsDir;
}
function platformPackagePrebuildsDir(sources) {
    if (!sources.host) {
        return null;
    }
    const manifestPath = sources.resolveManifest(hostPlatformPackage(sources.host) + PLATFORM_MANIFEST_SUBPATH);
    if (!manifestPath) {
        return null;
    }
    return path.join(path.dirname(manifestPath), PLATFORM_ADDON_DIR_NAME, PREBUILDS_DIR_NAME);
}
function resolveBackendsDir() {
    return resolveBackendsDirFrom({
        localPrebuildsDir: path.join(PACKAGE_ROOT, PREBUILDS_DIR_NAME),
        host: currentHost(),
        directoryExists: safeDirectoryExists,
        resolveManifest: safeResolveManifest,
    });
}
function currentHost() {
    return require.addon ? require.addon.host : null;
}
function safeDirectoryExists(dir) {
    try {
        return fs.existsSync(dir);
    }
    catch {
        return false;
    }
}
function safeResolveManifest(specifier) {
    try {
        return require.resolve(specifier);
    }
    catch {
        return null;
    }
}
