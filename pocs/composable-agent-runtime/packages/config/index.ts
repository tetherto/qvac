export {
  CONFIG_SNAPSHOT_VERSION,
  deserializeConfig,
  serializeConfig
} from './lib/snapshot.ts'
export { defineConfigKey, resolveConfig } from './lib/resolve.ts'
export {
  createConfigStore,
  getConfigSnapshot,
  getConfigValue,
  getOptionalConfigSnapshot,
  installConfig
} from './lib/store.ts'
export type {
  ConfigKey,
  ConfigSnapshot,
  ConfigStore,
  ConfigValue,
  DefineConfigKeyOptions,
  ResolveConfigOptions
} from './lib/types.ts'
