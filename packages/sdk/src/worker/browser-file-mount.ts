import { mountFile } from '@qvac/inference/browser'

export interface BrowserFileMount {
  path: string
  file: File
}

function validatePath(path: string): { parent: string; name: string } {
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) {
    throw new Error('Invalid browser file mount path')
  }
  const parts = path.slice(1).split('/')
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid browser file mount path')
  }
  return { parent: parts.slice(0, -1).join('/'), name: parts.at(-1)! }
}

export function mountBrowserFileGroup(
  entries: readonly BrowserFileMount[],
  mount: (path: string, file: File) => void = mountFile
): void {
  if (entries.length === 0) throw new Error('Invalid browser file mount request')

  let parent: string | undefined
  const names = new Set<string>()
  for (const entry of entries) {
    if (!(entry?.file instanceof File) || typeof entry.path !== 'string') {
      throw new Error('Invalid browser file mount request')
    }
    const path = validatePath(entry.path)
    if (parent === undefined) parent = path.parent
    if (path.parent !== parent || names.has(path.name)) {
      throw new Error('Browser files mounted together must have one directory and unique names')
    }
    names.add(path.name)
  }

  for (const { path, file } of entries) mount(path, file)
}
