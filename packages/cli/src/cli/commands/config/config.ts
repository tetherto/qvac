import type { ParsedCommand, LauncherKit, LoadedConfig, LaunchOptions } from '@qvac/cli-kit/launch'
import {
  applyPluginState,
  describeConfig,
  readPluginState,
  runtimeJson
} from '@qvac/cli-kit/config'

// `qvac config`: the merged configuration, one `key = value · source` line each.
export function configText({ config, sources, configPath }: LoadedConfig, { json }: LaunchOptions) {
  if (json) {
    return runtimeJson({ configPath, config, sources })
  }

  const from = configPath ? `from ${configPath}` : 'no qvac.config file here; built-in defaults'

  return [`QV.AC configuration, ${from}`, '', ...describeConfig(config, sources)].join('\n')
}

// qvac config: the merged configuration with where each value came from, plugin state applied
export async function runConfig(
  { options }: ParsedCommand,
  { loadConfig, dataDir, fs }: LauncherKit
) {
  const loaded = await loadConfig(options.configFile)
  const state = readPluginState(dataDir(options, loaded.config.core), fs)
  console.log(configText(applyPluginState(loaded, state), options))
}
