import { registerPlugins } from "@/server/plugins";
import * as hostApi from "@/client/api";
import type { QvacPlugin } from "@/schemas/plugin";

/**
 * Register plugins and return the client host API. Designed for
 * @qvac/bare-sdk consumers assembling explicit plugin subsets.
 */
export function plugins(
  pluginList: readonly QvacPlugin[],
): typeof hostApi {
  registerPlugins(pluginList);
  return hostApi;
}
