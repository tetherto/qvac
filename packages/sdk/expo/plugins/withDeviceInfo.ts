import type { ExpoConfig } from "expo/config";
import * as fs from "fs";
import * as path from "path";
import { resolveSDKPackageDir } from "./resolve-sdk-package-dir";

let didRun = false;

/**
 * Expo plugin that stubs expo-device-info when expo-device is not a declared
 * dependency of the consuming app. Expo autolinking resolves modules from
 * package.json — if expo-device isn't listed there, the native module won't
 * be linked and Metro may fail to resolve the JS import.
 */
function withDeviceInfo(config: ExpoConfig): ExpoConfig {
  if (didRun) {
    return config;
  }
  didRun = true;
  const projectRoot = config._internal?.["projectRoot"] as string | undefined;
  if (!projectRoot) {
    return config;
  }

  const { dir: qvacSdkPath } = resolveSDKPackageDir(projectRoot);

  const appPackageJsonPath = path.join(projectRoot, "package.json");
  let hasExpoDevice = false;
  if (fs.existsSync(appPackageJsonPath)) {
    const appPackageJson = JSON.parse(
      fs.readFileSync(appPackageJsonPath, "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    hasExpoDevice =
      "expo-device" in (appPackageJson.dependencies ?? {}) ||
      "expo-device" in (appPackageJson.devDependencies ?? {});
  }

  if (!hasExpoDevice) {
    const deviceInfoPath = path.join(
      qvacSdkPath,
      "dist",
      "client",
      "rpc",
      "expo-device-info.js",
    );
    if (fs.existsSync(deviceInfoPath)) {
      fs.writeFileSync(
        deviceInfoPath,
        [
          `"use strict";`,
          `Object.defineProperty(exports, "__esModule", { value: true });`,
          `async function getDeviceInfo() {`,
          `  return { platform: undefined, deviceModel: undefined, deviceBrand: undefined };`,
          `}`,
          `exports.getDeviceInfo = getDeviceInfo;`,
        ].join("\n"),
      );
      console.log(
        "[withDeviceInfo] 🔧 QVAC: expo-device not in app dependencies, stubbed device info",
      );
    }
  } else {
    console.log(
      "[withDeviceInfo] 🔧 QVAC: expo-device in app dependencies, using expo-device info",
    );
  }

  return config;
}

export default withDeviceInfo;
