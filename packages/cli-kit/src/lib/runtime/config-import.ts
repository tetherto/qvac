import { register } from 'node:module'

// Hooks load by URL, which no loader rewrites, so they take this module's own .ts or .js
const own = (name: string) => new URL(`./${name}${import.meta.url.slice(-3)}`, import.meta.url)

register(own('harness-resolve-hook'), { data: { parentURL: import.meta.url } })

register(own('config-typescript-hook'))

// Scope native transforms and TypeScript resolution to this config's local graph.
// Installed SDK/harness packages keep Node's normal module identity and conditions.
export async function importConfig(url: string) {
  if (!url.endsWith('.ts')) return import(url)
  try {
    return await import(`qvac-config:${encodeURIComponent(url)}`)
  } catch (cause) {
    if (cause instanceof SyntaxError || (cause as Error)?.name === 'SyntaxError') {
      throw new Error(
        `Cannot load TypeScript config ${url}. Use Node-supported TypeScript; compile JSX, decorators and other compiler-only syntax to JavaScript first.`,
        { cause }
      )
    }
    throw cause
  }
}

// Node's public import.meta.resolve ignores arbitrary parents without a flag.
// The existing async loader hook can ask Node's native ESM resolver directly.
export async function resolveFrom(specifier: string, parentURL: string): Promise<string> {
  const request = encodeURIComponent(JSON.stringify([specifier, parentURL]))
  const resolved = (await import(`qvac-resolve:${request}`)) as { default: string }
  return resolved.default
}
