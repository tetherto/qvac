import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";
import * as fs from "fs";
import * as path from "path";
import { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } from "@/commands";
import { CONFIG_CANDIDATES } from "@/client/config-loader/resolve-config.node";
import { resolveSDKPackageDir } from "@/expo/plugins/resolve-sdk-package-dir";
import { getProjectRootFromMod } from "@/expo/plugins/get-project-root";
import { findInAncestorNodeModules } from "@/expo/plugins/find-in-ancestor-node-modules";
import { BundleVerificationFailedError } from "@/utils/errors-client";

const { withDangerousMod } = configPlugins;

/** Modules to defer from mobile bundles (not available at bundle time) */
const DEFERRED_MODULES = ["expo-file-system", "react-native-bare-kit"];

const MOBILE_HOSTS = [
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
];

/**
 * Expo plugin: bundle, verify, then copy the mobile worker bundle.
 *
 * Flow: bundleSdk -> verifyBundle -> copy to `<sdkPackageDir>/dist/worker.mobile.bundle.js`.
 * Uses `qvac.config.*` if present.
 */
function withMobileBundle(config: ExpoConfig): ExpoConfig {
  async function buildMobileBundle(
    config: configPlugins.ExportedConfigWithProps<unknown>,
  ) {
    const projectRoot = getProjectRootFromMod(config);
    const sdkPackage = resolveSDKPackageDir(projectRoot);
    const outputPath = path.join(
      sdkPackage.dir,
      "dist",
      "worker.mobile.bundle.js",
    );

    const configPath = findConfigFile(projectRoot);
    if (configPath) {
      console.log(
        `🕚 QVAC: Found ${path.basename(configPath)}, generating tree-shaken bundle...`,
      );
    } else {
      console.log(
        "🕚 QVAC: No config found, generating default bundle (all plugins)...",
      );
    }

    const deferredModules = [
      ...DEFERRED_MODULES,
      `${sdkPackage.name}/worker.mobile.bundle`,
    ];
    await runBundler(
      projectRoot,
      sdkPackage.dir,
      configPath,
      deferredModules,
    );

    const generatedBundle = path.join(projectRoot, "qvac", "worker.bundle.js");
    await runVerifier(projectRoot, generatedBundle, configPath);

    fs.copyFileSync(generatedBundle, outputPath);

    console.log("🫡 QVAC: Mobile bundle generated and verified");
    return config;
  }

  config = withDangerousMod(config, ["android", buildMobileBundle]);
  config = withDangerousMod(config, ["ios", buildMobileBundle]);
  return config;
}

/** Finds qvac.config.* file in project root */
function findConfigFile(projectRoot: string): string | null {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

async function runVerifier(
  projectRoot: string,
  generatedBundle: string,
  configPath: string | null,
) {
  if (!configPath) {
    console.log(
      "⚠️ QVAC: no qvac.config.* found — Bare runtime will be auto-detected " +
        "from node_modules (bare-runtime, then bare). Add qvac.config.json " +
        "with `bareRuntimeVersion` to pin ABI checks deterministically.",
    );
  }

  const result = await verifyBundle({
    projectRoot,
    addonsSource: generatedBundle,
    hosts: MOBILE_HOSTS,
    ...(configPath ? { configPath } : {}),
  });

  if (hasErrors(result)) {
    throw new BundleVerificationFailedError(
      generatedBundle,
      new Error(formatVerifyBundleResult(result)),
    );
  }
}

async function runBundler(
  projectRoot: string,
  qvacSdkPath: string,
  configPath: string | null,
  deferredModules: string[],
) {
  patchBareKitLinkers(projectRoot, qvacSdkPath);

  await bundleSdk({
    projectRoot,
    sdkPath: qvacSdkPath,
    ...(configPath ? { configPath } : {}),
    hosts: MOBILE_HOSTS,
    defer: deferredModules,
    quiet: true,
  });
}

/**
 * Patches react-native-bare-kit linkers to use the addons manifest.
 */
function patchBareKitLinkers(projectRoot: string, qvacSdkPath: string) {
  const bareKitPath = findInAncestorNodeModules(
    projectRoot,
    "react-native-bare-kit",
  );
  if (bareKitPath === null) {
    console.warn(
      "⚠️ QVAC: react-native-bare-kit not found in any ancestor node_modules, " +
        "skipping linker patch. The bundle will link all native addons " +
        "rather than only those required by your bundle.",
    );
    return;
  }

  const patchesDir = path.join(qvacSdkPath, "expo", "plugins", "patches");
  if (!fs.existsSync(patchesDir)) {
    console.log(
      `⚠️ QVAC: patches directory not found (${patchesDir}), skipping linker patch`,
    );
    return;
  }

  const androidPatch = path.join(patchesDir, "android-link.mjs");
  const androidTarget = path.join(bareKitPath, "android", "link.mjs");
  if (fs.existsSync(androidPatch)) {
    fs.copyFileSync(androidPatch, androidTarget);
    console.log("✅ QVAC: Patched android/link.mjs for manifest-aware linking");
  } else {
    console.log(`⚠️ QVAC: Android linker patch not found (${androidPatch})`);
  }

  const iosPatch = path.join(patchesDir, "ios-link.mjs");
  const iosTarget = path.join(bareKitPath, "ios", "link.mjs");
  if (fs.existsSync(iosPatch)) {
    fs.copyFileSync(iosPatch, iosTarget);
    console.log("✅ QVAC: Patched ios/link.mjs for manifest-aware linking");
  } else {
    console.log(`⚠️ QVAC: iOS linker patch not found (${iosPatch})`);
  }
}

export { MOBILE_HOSTS };

export default withMobileBundle;
