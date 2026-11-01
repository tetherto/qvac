import type { ServeExtension } from '@/serve/core/extensions'
import defaultExtension from '@/serve/extensions/default'
import openaiExtension from '@/serve/extensions/openai'

/** Mounted unless `--no-default` is passed; every other extension needs its flag. */
export const DEFAULT_EXTENSION = defaultExtension.name

export const EXTENSIONS: readonly ServeExtension[] = [defaultExtension, openaiExtension]

export function resolveExtensions(names?: readonly string[]): ServeExtension[] {
  if (names === undefined) return [...EXTENSIONS]

  return names.map((name) => {
    const extension = EXTENSIONS.find((candidate) => candidate.name === name)
    if (!extension) {
      throw new Error(
        `Unknown serve extension "${name}". Available: ${EXTENSIONS.map((e) => e.name).join(', ')}.`
      )
    }
    return extension
  })
}
