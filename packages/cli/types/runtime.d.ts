declare module '#config-import' {
  export function importConfig(url: string): Promise<{ default: unknown }>
  export function resolveFrom(specifier: string, parentURL: string): Promise<string> | string
}
