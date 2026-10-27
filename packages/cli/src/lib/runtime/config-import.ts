import { register } from 'node:module'
import { tsImport } from 'tsx/esm/api'

register(new URL('./harness-resolve-hook.js', import.meta.url), {
  data: { parentURL: import.meta.url }
})

// tsx breaks the harness's CommonJS imports, which an inline plugin pulls in, so only .ts uses it.
export const importConfig = (url: string) =>
  url.endsWith('.ts') ? tsImport(url, import.meta.url) : import(url)

// Node's public import.meta.resolve ignores arbitrary parents without a flag.
// The existing async loader hook can ask Node's native ESM resolver directly.
export async function resolveFrom(specifier: string, parentURL: string): Promise<string> {
  const request = encodeURIComponent(JSON.stringify([specifier, parentURL]))
  const resolved = (await import(`qvac-resolve:${request}`)) as { default: string }
  return resolved.default
}
