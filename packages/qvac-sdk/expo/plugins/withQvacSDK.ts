import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";
import withDeviceInfo from "./withDeviceInfo";
import withMobileBundle from "./withMobileBundle";
import withOpenCL from "./withOpenCL";

const { withPlugins } = configPlugins;

/**
 * Main Qvac SDK Expo plugin that combines all necessary mobile configurations:
 * - Mobile worker bundle generation
 * - Device info stubbing when expo-device is not installed
 * - OpenCL native library support for Android
 */
function withQvacSDK(config: ExpoConfig): ExpoConfig {
  return withPlugins(config, [withMobileBundle, withDeviceInfo, withOpenCL]);
}

export default withQvacSDK;
