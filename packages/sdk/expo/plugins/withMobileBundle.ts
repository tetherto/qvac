import configPlugins from "@expo/config-plugins";
import { execSync } from "child_process";
import type { ExpoConfig } from "expo/config";
import * as fs from "fs";
import * as path from "path";
import {
  SDKNotFoundInNodeModulesError,
  WorkerFileNotFoundError,
} from "@/utils/errors-client";

const { withDangerousMod } = configPlugins;

/**
 * Expo plugin that automatically generates the mobile worker bundle during build
 * using the user's installed bare library versions.
 */
function withMobileBundle(config: ExpoConfig): ExpoConfig {
  function buildMobileBundle(
    config: configPlugins.ExportedConfigWithProps<unknown>,
  ) {
    console.log(
      "🕚 QVAC: Generating mobile worker bundle with current dependencies...",
    );

    const projectRoot = config.modRequest.projectRoot;
    const qvacSdkPath = path.join(projectRoot, "node_modules", "@qvac/sdk");

    // Ensure package exists
    if (!fs.existsSync(qvacSdkPath)) {
      throw new SDKNotFoundInNodeModulesError();
    }

    const workerPath = path.join(qvacSdkPath, "dist", "server", "worker.js");
    const outputPath = path.join(qvacSdkPath, "dist/worker.mobile.bundle.js");

    // Check if worker.js exists
    if (!fs.existsSync(workerPath)) {
      throw new WorkerFileNotFoundError(workerPath);
    }

    try {
      // Truncate incompatible RPC clients for mobile
      // Keep: rpc-client.js, expo-rpc-client.js, bare-client.js (needed for worker bundle)
      const rpcClientsToTruncate = ["node-rpc-client.js"];

      const truncatedContent =
        "// This RPC client is not available in mobile environments";

      for (const clientFile of rpcClientsToTruncate) {
        const clientPath = path.join(
          qvacSdkPath,
          "dist",
          "client",
          "rpc",
          clientFile,
        );

        if (fs.existsSync(clientPath)) {
          fs.writeFileSync(clientPath, truncatedContent);
          console.log(
            `🔧 QVAC: Truncated ${clientFile} for mobile compatibility`,
          );
        }
      }

      // Copy bare imports configuration for bare-pack
      const bareImportsSource = path.join(qvacSdkPath, "bare-imports.json");
      const importsMapPath = path.join(qvacSdkPath, "dist", "imports.json");
      if (fs.existsSync(bareImportsSource)) {
        fs.copyFileSync(bareImportsSource, importsMapPath);
        console.log("🔧 QVAC: Copied bare-imports.json for mobile bundle");
      }

      // Remove optional modules from the bundle
      const optionalModules = [
        "expo-file-system",
        "react-native-bare-kit",
        "@qvac/sdk/worker.mobile.bundle",
      ];
      const deferFlags = optionalModules
        .map((mod) => `--defer "${mod}"`)
        .join(" ");

      // Detect bare-pack version (v1.x uses --target, v2.x uses --host)
      let platformFlag = "--host";
      try {
        const versionOutput = execSync(
          `npx bare-pack --version "${workerPath}"`,
          { cwd: projectRoot, encoding: "utf-8" },
        ).trim();
        const versionMatch = versionOutput.match(/v?(\d+)\./);
        const majorVersion =
          versionMatch && versionMatch[1] ? parseInt(versionMatch[1], 10) : 2;
        if (majorVersion < 2) {
          platformFlag = "--target";
        }
      } catch (error) {
        throw new Error(
          `Failed to detect bare-pack version. Ensure bare-pack is installed: npm install bare-pack`,
          { cause: error },
        );
      }

      const platforms = ["android-arm64", "ios-arm64", "ios-arm64-simulator"];
      const platformFlags = platforms
        .map((p) => `${platformFlag} ${p}`)
        .join(" ");

      // Generate the bundle using bare-pack with the current project's dependencies
      execSync(
        `cd "${projectRoot}" && npx bare-pack ${platformFlags} --linked --imports "${importsMapPath}" ${deferFlags} --out "${outputPath}" "${workerPath}"`,
        { stdio: "inherit", cwd: projectRoot },
      );

      console.log("🫡 QVAC: Mobile worker bundle generated successfully");
    } catch (error) {
      console.error("❌ QVAC: Failed to generate mobile worker bundle:", error);
      throw error;
    }

    return config;
  }

  config = withDangerousMod(config, ["android", buildMobileBundle]);
  config = withDangerousMod(config, ["ios", buildMobileBundle]);
  return config;
}

export default withMobileBundle;
