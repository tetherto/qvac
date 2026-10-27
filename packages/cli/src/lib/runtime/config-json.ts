import type { WorkbenchConfig, LoadedConfig } from '../types.js'
import { inlinePlugin } from './config-merge.js'

// An inline plugin or extension cannot cross into Bare as JSON; it is found again in configPath.
export function runtimeJson({
  config,
  sources,
  configPath
}: { config: WorkbenchConfig } & Partial<Omit<LoadedConfig, 'config'>>) {
  return JSON.stringify({ config: withMarkers(config), sources, configPath }, refuseFunctions)
}

function withMarkers(config: WorkbenchConfig) {
  const harness = config.harness && { ...config.harness, plugins: markers(config.harness.plugins) }
  const tui = config.tui && { ...config.tui, extensions: markers(config.tui.extensions) }
  return { ...config, harness, tui }
}

const markers = (plugins: unknown[] | undefined) => plugins?.map(marker)

function marker(entry: unknown, index: number) {
  const plugin = inlinePlugin(entry)
  if (!plugin) {
    return entry
  }

  const descriptor = entry as { plugin?: unknown; inline?: number }
  const { plugin: _plugin, ...rest } = plugin === entry ? {} : descriptor

  return { ...rest, inline: descriptor.inline ?? index, name: plugin.name }
}

function refuseFunctions(_key: string, value: unknown) {
  if (typeof value === 'function' || typeof value === 'bigint') {
    throw new Error(
      'Configuration must be serializable; list a plugin inline or put it in a module named by use'
    )
  }

  return value
}
