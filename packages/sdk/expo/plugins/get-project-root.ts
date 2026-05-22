import type { ExportedConfigWithProps } from "@expo/config-plugins";
import type { ExpoConfig } from "expo/config";

/**
 * `projectRoot` resolution in Expo plugins depends on plugin type:
 *
 * - **Mod plugins** (callbacks passed to `withDangerousMod` etc.) receive an
 *   `ExportedConfigWithProps<...>` whose `modRequest.projectRoot` is the
 *   documented public API for the consumer's project directory.
 * - **Base plugins** (called with the bare `ExpoConfig`) run before any mod
 *   cycle and have no `modRequest`. The only way to recover the project root
 *   is the (undocumented but stable) `_internal.projectRoot` escape hatch
 *   Expo's config-plugins runtime attaches to the config it hands plugins.
 *
 * Both helpers exist so the two access patterns are picked deliberately —
 * call the one that matches the plugin shape you're in. Don't reach into the
 * raw fields directly; that's how `withMobileBundle` and `withDeviceInfo`
 * silently disagreed on which directory they were resolving against.
 */
function getProjectRootFromMod(config: ExportedConfigWithProps<unknown>) {
  return config.modRequest.projectRoot;
}

function getProjectRootFromBaseConfig(config: ExpoConfig) {
  return config._internal?.["projectRoot"] as string | undefined;
}

export { getProjectRootFromMod, getProjectRootFromBaseConfig };
