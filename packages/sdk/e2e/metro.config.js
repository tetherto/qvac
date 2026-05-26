// SDK-specific Metro configuration
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);
config.resolver = config.resolver || {};


const extraAssetExts = ['ogg', 'wma', 'aac', 'm4a', 'wav', 'mp3', 'txt', 'jsonl'];
config.resolver.assetExts = Array.from(
    new Set([...(config.resolver.assetExts || []), ...extraAssetExts])
);

// Find the actual sdk location by following the symlink
const projectRoot = __dirname;

// When this runs from build/consumers/android, node_modules/@qvac/sdk is a symlink
// Follow it to find the real SDK location
const sdkSymlink = path.join(projectRoot, 'node_modules/@qvac/sdk');
let qvacSdkPath;

try {
    if (fs.existsSync(sdkSymlink)) {
        qvacSdkPath = fs.realpathSync(sdkSymlink);
        console.log('[Metro] Resolved @qvac/sdk symlink to:', qvacSdkPath);

        config.watchFolders = [projectRoot, qvacSdkPath];

        // Add SDK's node_modules to resolver paths
        config.resolver.nodeModulesPaths = [
            path.resolve(projectRoot, 'node_modules'),
            path.resolve(qvacSdkPath, 'node_modules'),
        ];
    }
} catch (e) {
    console.error('[Metro] Failed to resolve @qvac/sdk symlink:', e.message);
}

// Redirect bare @tetherto/qvac-test-suite imports to the /mobile entry point,
// which excludes Node.js-only modules (config-loader, test-loader) that use
// dynamic import() and node:fs — incompatible with Metro.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === '@tetherto/qvac-test-suite') {
        return context.resolveRequest(context, '@tetherto/qvac-test-suite/mobile', platform);
    }
    if (originalResolveRequest) {
        return originalResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
