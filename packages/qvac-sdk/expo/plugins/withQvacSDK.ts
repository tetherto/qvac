import configPlugins from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";
import withMobileBundle from "./withMobileBundle";
import withOpenCL from "./withOpenCL";

const { withPlugins } = configPlugins;

/**
 * Main Qvac SDK Expo plugin that combines all necessary mobile configurations:
 * - Mobile worker bundle generation
 * - OpenCL native library support for Android
 */
function withQvacSDK(config: ExpoConfig): ExpoConfig {
  return withPlugins(config, [withMobileBundle, withOpenCL]);
}

export default withQvacSDK;
