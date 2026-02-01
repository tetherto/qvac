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
      // Truncate incompatible RPC clients for mobile (keep only rpc-client.js and expo-rpc-client.js)
      const rpcClientsToTruncate = [
        "node-rpc-client.js",
        "bare-rpc-client.js",
        "bare-client.js",
      ];

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

      // Remove optional modules from the bundle
      const optionalModules = [
        "crypto",
        "expo-file-system",
        "react-native-bare-kit",
        "@qvac/sdk/worker.mobile.bundle",
      ];
      const deferFlags = optionalModules
        .map((mod) => `--defer "${mod}"`)
        .join(" ");
      // Generate the bundle using bun bare-pack with the current project's dependencies
      // We use the project root as working directory so bare-pack uses the user's node_modules
      execSync(
        `cd "${projectRoot}" && npx bare-pack --target android-arm64 --target ios-arm64 --target ios-arm64-simulator --linked ${deferFlags} --out "${outputPath}" "${workerPath}"`,
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
