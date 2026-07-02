import { registerPlugins } from './registry'
import * as hostApi from '../api'
import type { QvacPlugin } from '../schemas/plugin'

export {
  registerPlugin,
  registerPlugins,
  getPlugin,
  getPluginHandler,
  hasPlugin,
  getAllPlugins,
  clearPlugins,
  unregisterPlugin
} from './registry'

/**
 * Register a set of plugins and return the host API bound to them. The
 * ergonomic entry point for assembling an explicit plugin subset — core ships
 * no default plugins, so an app registers exactly the engines it needs.
 */
export function plugins(pluginList: readonly QvacPlugin[]): typeof hostApi {
  registerPlugins(pluginList)
  return hostApi
}
