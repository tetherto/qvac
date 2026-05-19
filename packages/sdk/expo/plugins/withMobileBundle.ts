import configPlugins from "@expo/config-plugins";
import { execSync } from "child_process";
import type { ExpoConfig } from "expo/config";
import * as fs from "fs";
import * as path from "path";
import { resolveSDKPackageDir } from "./resolve-sdk-package-dir";
import { BundleVerificationFailedError } from "@/utils/errors-client";

const { withDangerousMod } = configPlugins;

const CONFIG_CANDIDATES = [
  "qvac.config.json",
  "qvac.config.js",
  "qvac.config.mjs",
];

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
 * Flow: `bundle sdk` -> assert `qvac/worker.bundle.js` exists ->
 * `verify bundle` -> copy to `<sdkPackageDir>/dist/worker.mobile.bundle.js`.
 * Requires a local `@qvac/cli` install. Uses `qvac.config.*` if present.
 */
function withMobileBundle(config: ExpoConfig): ExpoConfig {
  function buildMobileBundle(
    config: configPlugins.ExportedConfigWithProps<unknown>,
  ) {
    const projectRoot = config.modRequest.projectRoot;
    const sdkPackage = resolveSDKPackageDir(projectRoot);
    const outputPath = path.join(
      sdkPackage.dir,
      "dist",
      "worker.mobile.bundle.js",
    );

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

    const deferredModules = [
      ...DEFERRED_MODULES,
      `${sdkPackage.name}/worker.mobile.bundle`,
    ];
    runBundler(projectRoot, sdkPackage.dir, configPath, deferredModules);

    // Copy the generated bundle to SDK location
    const generatedBundle = path.join(projectRoot, "qvac", "worker.bundle.js");
    if (!fs.existsSync(generatedBundle)) {
      throw new Error(
        `QVAC: Bundle generation failed — ${generatedBundle} not found. ` +
          `Check qvac CLI output above for errors.`,
      );
    }

    // Verify before copying so the dist artifact only updates on success.
    runVerifier(projectRoot, generatedBundle, configPath);

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

/**
 * Resolves the qvac CLI command.
 *
 * Prefers local @qvac/cli installation for version consistency,
 * falls back to npx for convenience when CLI is not installed.
 */
export function resolveCliCommand(projectRoot: string): string {
  const cliPath = path.join(
    projectRoot,
    "node_modules",
    "@qvac",
    "cli",
    "dist",
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
  return "npx --package=@qvac/cli qvac";
}

/** Builds the `qvac verify bundle` command string (pure helper for tests). */
export function buildVerifyBundleCommand(opts: {
  cliCommand: string;
  bundlePath: string;
  hosts: string[];
  configPath?: string;
}): string {
  const hostFlags = opts.hosts.map((h) => `--host ${h}`).join(" ");
  const configFlag = opts.configPath ? ` --config "${opts.configPath}"` : "";
  return `${opts.cliCommand} verify bundle --addons-source "${opts.bundlePath}" ${hostFlags}${configFlag}`;
}

/**
 * Runs `qvac verify bundle` against the freshly generated worker bundle.
 * Passes the discovered `qvac.config.*` so the CLI reads `bareRuntimeVersion`
 * and pins ABI checks deterministically. Without a config, the CLI falls back
 * to auto-detecting Bare runtime from `node_modules` (`bare-runtime`, then
 * `bare`); ABI checks stay strict when that lookup succeeds, and only skip
 * (with an `unknown-runtime-version` warning) when neither is installed.
 */
function runVerifier(
  projectRoot: string,
  generatedBundle: string,
  configPath: string | null,
) {
  const cliCommand = resolveCliCommand(projectRoot);

  if (!configPath) {
    console.log(
      "⚠️ QVAC: no qvac.config.* found — Bare runtime will be auto-detected " +
        "from node_modules (bare-runtime, then bare). Add qvac.config.json " +
        'with `bareRuntimeVersion` to pin ABI checks deterministically.',
    );
  }

  const verifyCommand = buildVerifyBundleCommand({
    cliCommand,
    bundlePath: generatedBundle,
    hosts: MOBILE_HOSTS,
    ...(configPath ? { configPath } : {}),
  });

  try {
    execSync(verifyCommand, { stdio: "inherit", cwd: projectRoot });
  } catch (error) {
    throw new BundleVerificationFailedError(generatedBundle, error);
  }
}

/** Runs qvac CLI with mobile-specific options */
function runBundler(
  projectRoot: string,
  qvacSdkPath: string,
  configPath: string | null,
  deferredModules: string[],
) {
  // Patch bare-kit linkers to use addons manifest
  patchBareKitLinkers(projectRoot, qvacSdkPath);

  const hostFlags = MOBILE_HOSTS.map((h) => `--host ${h}`).join(" ");
  const deferFlags = deferredModules.map((m) => `--defer "${m}"`).join(" ");
  const configFlag = configPath ? `--config "${configPath}"` : "";
  const sdkPathFlag = `--sdk-path "${qvacSdkPath}"`;
  const cliCommand = resolveCliCommand(projectRoot);

  try {
    execSync(
      `${cliCommand} bundle sdk ${sdkPathFlag} ${configFlag} ${hostFlags} ${deferFlags} --quiet`,
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

export { MOBILE_HOSTS };

export default withMobileBundle;
