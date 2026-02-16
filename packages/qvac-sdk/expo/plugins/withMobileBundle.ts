import configPlugins from "@expo/config-plugins";
import { execSync } from "child_process";
import type { ExpoConfig } from "expo/config";
import * as fs from "fs";
import * as path from "path";
import { SDKNotFoundInNodeModulesError } from "@/utils/errors-client";

const { withDangerousMod } = configPlugins;

const CONFIG_CANDIDATES = [
  "qvac.config.json",
  "qvac.config.js",
  "qvac.config.mjs",
];

/** Modules to defer from mobile bundles (not available at bundle time) */
const DEFERRED_MODULES = [
  "expo-file-system",
  "react-native-bare-kit",
  "@qvac/sdk/worker.mobile.bundle",
];

const MOBILE_HOSTS = [
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
];

/**
 * Expo plugin that automatically generates the mobile worker bundle during build.
 *
 * Runs qvac CLI (prefers local @qvac/cli, falls back to npx).
 * Uses qvac.config.* if exists, else includes all built-in plugins.
 * Output: node_modules/@qvac/sdk/dist/worker.mobile.bundle.js
 */
function withMobileBundle(config: ExpoConfig): ExpoConfig {
  function buildMobileBundle(
    config: configPlugins.ExportedConfigWithProps<unknown>,
  ) {
    const projectRoot = config.modRequest.projectRoot;
    const qvacSdkPath = path.join(projectRoot, "node_modules", "@qvac/sdk");
    const outputPath = path.join(
      qvacSdkPath,
      "dist",
      "worker.mobile.bundle.js",
    );

    // Ensure SDK package exists
    if (!fs.existsSync(qvacSdkPath)) {
      throw new SDKNotFoundInNodeModulesError();
    }

    // Generate bundle via qvac CLI
    // (uses qvac.config.* if exists, else includes all built-in plugins)
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

    runBundler(projectRoot, qvacSdkPath, configPath);

    // Copy the generated bundle to SDK location
    const generatedBundle = path.join(projectRoot, "qvac", "worker.bundle.js");
    if (!fs.existsSync(generatedBundle)) {
      throw new Error(
        `QVAC: Bundle generation failed — ${generatedBundle} not found. ` +
          `Check qvac CLI output above for errors.`,
      );
    }
    fs.copyFileSync(generatedBundle, outputPath);

    console.log("🫡 QVAC: Mobile bundle generated");
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

/**
 * Resolves the qvac CLI command.
 *
 * Prefers local @qvac/cli installation for version consistency,
 * falls back to npx for convenience when CLI is not installed.
 */
function resolveCliCommand(projectRoot: string): string {
  const cliPath = path.join(
    projectRoot,
    "node_modules",
    "@qvac",
    "cli",
    "src",
    "index.js",
  );

  if (fs.existsSync(cliPath)) {
    return `node "${cliPath}"`;
  }

  console.log(
    "⚠️ QVAC: @qvac/cli not found in node_modules, falling back to npx",
  );
  console.log(
    "   Tip: Add @qvac/cli as a dependency for consistent versioning",
  );
  return "npx qvac";
}

/** Runs qvac CLI with mobile-specific options */
function runBundler(
  projectRoot: string,
  qvacSdkPath: string,
  configPath: string | null,
) {
  // Truncate incompatible RPC clients for mobile
  truncateNodeRpcClient(qvacSdkPath);

  // Patch bare-kit linkers to use addons manifest
  patchBareKitLinkers(projectRoot, qvacSdkPath);

  const hostFlags = MOBILE_HOSTS.map((h) => `--host ${h}`).join(" ");
  const deferFlags = DEFERRED_MODULES.map((m) => `--defer "${m}"`).join(" ");
  const configFlag = configPath ? `--config "${configPath}"` : "";
  const cliCommand = resolveCliCommand(projectRoot);

  try {
    execSync(
      `${cliCommand} bundle sdk ${configFlag} ${hostFlags} ${deferFlags} --quiet`,
      { stdio: "inherit", cwd: projectRoot },
    );
  } catch (error) {
    console.error("❌ QVAC: Failed to generate bundle:", error);
    throw error;
  }
}

/**
 * Patches react-native-bare-kit linkers to use the addons manifest.
 *
 * Copies the manifest-aware link.mjs files over the originals so that
 * bare-link only links the native addons actually required by the bundle.
 * This reduces app size by excluding unused native addon binaries.
 */
function patchBareKitLinkers(projectRoot: string, qvacSdkPath: string) {
  const bareKitPath = path.join(
    projectRoot,
    "node_modules",
    "react-native-bare-kit",
  );
  if (!fs.existsSync(bareKitPath)) {
    console.log(
      "⚠️ QVAC: react-native-bare-kit not found, skipping linker patch",
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

  // Patch Android linker
  const androidPatch = path.join(patchesDir, "android-link.mjs");
  const androidTarget = path.join(bareKitPath, "android", "link.mjs");
  if (fs.existsSync(androidPatch)) {
    fs.copyFileSync(androidPatch, androidTarget);
    console.log("✅ QVAC: Patched android/link.mjs for manifest-aware linking");
  } else {
    console.log(`⚠️ QVAC: Android linker patch not found (${androidPatch})`);
  }

  // Patch iOS linker
  const iosPatch = path.join(patchesDir, "ios-link.mjs");
  const iosTarget = path.join(bareKitPath, "ios", "link.mjs");
  if (fs.existsSync(iosPatch)) {
    fs.copyFileSync(iosPatch, iosTarget);
    console.log("✅ QVAC: Patched ios/link.mjs for manifest-aware linking");
  } else {
    console.log(`⚠️ QVAC: iOS linker patch not found (${iosPatch})`);
  }
}

/**
 * Truncates node-rpc-client.js for mobile compatibility.
 *
 * Why this is needed:
 * - `node-rpc-client.js` imports Node.js-specific modules (bare-subprocess, fs, path)
 *   that are not available in React Native / mobile environments.
 * - Even though mobile apps use `expo-rpc-client.ts`, bare-pack's static analysis
 *   follows all imports from the SDK entry point, including the Node RPC client.
 * - Truncating this file removes the problematic import chain from the bundle graph.
 *
 * This is a build-time mutation of node_modules, only affecting the prebuild.
 * Future improvement: use package.json conditional exports to provide a stub
 * for React Native environments.
 */
function truncateNodeRpcClient(qvacSdkPath: string) {
  const clientPath = path.join(
    qvacSdkPath,
    "dist",
    "client",
    "rpc",
    "node-rpc-client.js",
  );
  const truncatedContent =
    "// This RPC client is not available in mobile environments";

  if (fs.existsSync(clientPath)) {
    fs.writeFileSync(clientPath, truncatedContent);
  }
}

export default withMobileBundle;
