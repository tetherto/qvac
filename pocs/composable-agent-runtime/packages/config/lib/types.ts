export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | readonly ConfigValue[]
  | { readonly [key: string]: ConfigValue }

export interface ConfigSnapshot {
  readonly version: 1
  readonly values: Readonly<Record<string, ConfigValue>>
}

export interface ConfigKey<T extends ConfigValue> {
  readonly name: string
  readonly env: readonly string[]
  readonly hasDefault: boolean
  readonly defaultValue?: T
  parse(value: ConfigValue): T
}

export interface DefineConfigKeyOptions<T extends ConfigValue> {
  readonly name: string
  readonly env?: readonly string[]
  readonly default?: T
  parse(value: ConfigValue): T
}

export interface ResolveConfigOptions {
  readonly keys: readonly ConfigKey<ConfigValue>[]
  readonly values?: Readonly<Record<string, ConfigValue>>
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface ConfigStore {
  install(snapshot: ConfigSnapshot): void
  optionalSnapshot(): ConfigSnapshot | undefined
  snapshot(): ConfigSnapshot
  get<T extends ConfigValue>(key: ConfigKey<T>): T
}
