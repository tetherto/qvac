import { createSyncExpoPlugin } from './lib/expo/plugin.ts'

export { composeSyncContribution } from './lib/expo/contribution.ts'
export { validateStandaloneContribution } from './lib/expo/finalize.ts'
export { createSyncExpoPlugin } from './lib/expo/plugin.ts'
export type {
  CreateSyncExpoPluginOptions,
  SyncBuildResult,
  SyncContribution
} from './lib/expo/types.ts'

export default createSyncExpoPlugin()
