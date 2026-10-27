import { inlinePlugin } from '../lib/runtime/config-merge.js'
import type { Extension, LoadedExtensions } from './extensions.js'
type Module = { default?: unknown }
type Load = (file: string) => Promise<Module>
interface Reference {
  name?: string
  use?: string
  inline?: number
  options?: Record<string, unknown>
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Expected an extension object')
  return value as Record<string, unknown>
}
function extension(value: unknown): Extension {
  const entry = object(value)
  if (entry['commands'] !== undefined && !Array.isArray(entry['commands'])) {
    throw new Error('Extension commands must be an array')
  }
  return entry as Extension
}
// `load(file)` imports a module relative to the config file's folder.
export async function loadExtensions(
  entries: unknown[] = [],
  { configPath, load }: { configPath?: string | null | undefined; load: Load }
): Promise<LoadedExtensions> {
  const extensions: LoadedExtensions['extensions'] = [],
    problems: string[] = []
  let config: Promise<Module> | null = null
  const inline = async (index: number) => {
    if (!configPath) throw new Error('Inline extensions require a configuration path')
    config ??= load(configPath)
    const source = object((await config).default)
    const list = object(source['tui'])['extensions']
    if (!Array.isArray(list)) throw new Error('Configuration has no extensions')
    return extension(inlinePlugin(list[index]))
  }
  for (const [i, entry] of entries.entries()) {
    const fallback = entryName(entry, i)
    try {
      const value = await resolve(entry, { inline, load })
      extensions.push({ name: value.name || fallback, extension: value })
    } catch (error) {
      problems.push(
        `Extension ${fallback} did not load: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { extensions, problems }
}
async function resolve(
  entry: unknown,
  { inline, load }: { inline(index: number): Promise<Extension>; load: Load }
): Promise<Extension> {
  if (typeof entry === 'string') return resolve({ use: entry }, { inline, load })
  const ref = object(entry) as Reference
  if (ref.inline !== undefined) return inline(ref.inline)
  if (!ref.use) return extension(entry)
  const exported = (await load(ref.use)).default
  return extension(typeof exported === 'function' ? await exported(ref.options ?? {}) : exported)
}
function entryName(entry: unknown, i: number): string {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return `#${i}`
  const value = entry as Reference
  return value.name || value.use || `#${i}`
}
