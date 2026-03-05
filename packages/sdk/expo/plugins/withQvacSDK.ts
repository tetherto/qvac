import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";
import withAndroidArchitecture from "./withAndroidArchitecture";
import withAndroidNdkVersion from "./withAndroidNdkVersion";
import withDeviceInfo from "./withDeviceInfo";
import withMobileBundle from "./withMobileBundle";
import withOpenCL from "./withOpenCL";

const { withPlugins } = configPlugins;

/**
 * Main Qvac SDK Expo plugin that combines all necessary mobile configurations:
 * - Mobile worker bundle generation
 * - Device info stubbing when expo-device is not installed
 * - Android build properties (minSdkVersion, NDK, proguard)
 * - Android NDK version pinning in build.gradle
 * - Android architecture filtering (arm64-v8a only)
 * - OpenCL native library support for Android
 */
function withQvacSDK(config: ExpoConfig): ExpoConfig {
  return withPlugins(config, [
    withMobileBundle,
    withDeviceInfo,
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 29,
          ndkVersion: "29.0.14206865",
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          enableMinifyInReleaseBuilds: true,
        },
      },
    ],
    withAndroidNdkVersion,
    withAndroidArchitecture,
    withOpenCL,
  ]);
}

export default withQvacSDK;
