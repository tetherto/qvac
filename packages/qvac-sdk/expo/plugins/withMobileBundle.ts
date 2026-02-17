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

type PackageVariant = {
  scope: string;
  sdk: string;
  cli: string;
  bin: string;
};

const PACKAGE_VARIANTS: PackageVariant[] = [
  { scope: "@tetherto", sdk: "sdk-mono", cli: "cli-mono", bin: "tetherto" },
  { scope: "@qvac", sdk: "sdk", cli: "cli", bin: "qvac" },
];

/**
 * Detects which package variant is installed based on SDK presence.
 * Throws if both or neither variant is found - exactly one must be installed.
 */
function detectPackageVariant(projectRoot: string): PackageVariant {
  const installedVariants = PACKAGE_VARIANTS.filter((variant) => {
    const sdkPath = path.join(
      projectRoot,
      "node_modules",
      variant.scope,
      variant.sdk,
    );
    return fs.existsSync(sdkPath);
  });

  if (installedVariants.length > 1) {
    const names = installedVariants
      .map((v) => `${v.scope}/${v.sdk}`)
      .join(", ");
    throw new Error(
      `QVAC: Multiple SDK variants detected (${names}). ` +
        `Only one scope (@tetherto or @qvac) can be installed at a time.`,
    );
  }

  if (installedVariants.length === 0) {
    throw new SDKNotFoundInNodeModulesError();
  }

  const variant = installedVariants[0]!;
  console.log(
    `🔍 QVAC: Detected ${variant.scope}/${variant.sdk} package variant`,
  );
  return variant;
}

/** Gets deferred modules for the detected variant */
function getDeferredModules(variant: PackageVariant): string[] {
  return [
    "expo-file-system",
    "react-native-bare-kit",
    `${variant.scope}/${variant.sdk}/worker.mobile.bundle`,
  ];
}

const MOBILE_HOSTS = [
  "android-arm64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
];

/**
 * Expo plugin that automatically generates the mobile worker bundle during build.
 *
 * Auto-detects package variant and uses the corresponding CLI.
 * Falls back to npx when CLI is not installed locally.
 * Uses qvac.config.* if exists, else includes all built-in plugins.
 */
function withMobileBundle(config: ExpoConfig): ExpoConfig {
  function buildMobileBundle(
    config: configPlugins.ExportedConfigWithProps<unknown>,
  ) {
    const projectRoot = config.modRequest.projectRoot;

    const variant = detectPackageVariant(projectRoot);
    const qvacSdkPath = path.join(
      projectRoot,
      "node_modules",
      variant.scope,
      variant.sdk,
    );
    const outputPath = path.join(
      qvacSdkPath,
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

    runBundler(projectRoot, qvacSdkPath, configPath, variant);

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
 * Resolves the CLI command for the detected package variant.
 *
 * Prefers local CLI installation for version consistency,
 * falls back to npx for convenience when CLI is not installed.
 */
function resolveCliCommand(
  projectRoot: string,
  variant: PackageVariant,
): string {
  const cliPath = path.join(
    projectRoot,
    "node_modules",
    variant.scope,
    variant.cli,
    "src",
    "index.js",
  );

  if (fs.existsSync(cliPath)) {
    return `node "${cliPath}"`;
  }

  const cliPackage = `${variant.scope}/${variant.cli}`;
  console.log(
    `⚠️ QVAC: ${cliPackage} not found in node_modules, falling back to npx`,
  );
  console.log(
    `   Tip: Add ${cliPackage} as a dependency for consistent versioning`,
  );
  return `npx --package=${cliPackage} ${variant.bin}`;
}

/** Runs CLI with mobile-specific options */
function runBundler(
  projectRoot: string,
  qvacSdkPath: string,
  configPath: string | null,
  variant: PackageVariant,
) {
  // Patch bare-kit linkers to use addons manifest
  patchBareKitLinkers(projectRoot, qvacSdkPath);

  const deferredModules = getDeferredModules(variant);
  const hostFlags = MOBILE_HOSTS.map((h) => `--host ${h}`).join(" ");
  const deferFlags = deferredModules.map((m) => `--defer "${m}"`).join(" ");
  const configFlag = configPath ? `--config "${configPath}"` : "";
  const sdkPathFlag = `--sdk-path "${qvacSdkPath}"`;
  const cliCommand = resolveCliCommand(projectRoot, variant);

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

export default withMobileBundle;
