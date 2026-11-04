// Relative imports, not aliased: this module is part of `source.config.ts`'s
// import graph, which the MDX config loader resolves outside the Next path
// aliases.
import {
  getDocumentedSoftware,
  isCurrentLineFolder,
  type DocumentedSoftware,
  type DocumentedVersion,
} from './versions'

/**
 * Which documentation line a content file belongs to, read from where the
 * file sits. Shared by the MDX plugins that need it, so the folder is the one
 * place a line is declared and no page states its own version.
 */

export interface ContentLine {
  /** The collection's URL prefix, without slashes: `sdk`. */
  collection: string
  software: DocumentedSoftware
  version: DocumentedVersion
  /** True for the line served at the collection's version-less paths. */
  current: boolean
}

const CONTENT_ROOT = 'content/docs/'

/**
 * The line of the file at `filePath`, or null when the file is outside a
 * collection published as lines.
 */
export function versionOfFile(filePath: string): ContentLine | null {
  const normalized = filePath.replaceAll('\\', '/')
  const at = normalized.lastIndexOf(CONTENT_ROOT)
  if (at === -1) return null

  const [collection, folder] = normalized
    .slice(at + CONTENT_ROOT.length)
    .split('/')
  if (!collection || !folder) return null

  const software = getDocumentedSoftware(`/${collection}`)
  if (!software || software.kind !== 'collection') return null

  const version = software.versions.find((entry) => entry.folder === folder)
  if (!version) return null

  return {
    collection,
    software,
    version,
    current: isCurrentLineFolder(version.folder),
  }
}
