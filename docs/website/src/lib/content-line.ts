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

  // The longest documented path the file lies under: a package documented
  // inside Ecosystem, `ecosystem/packages/<name>`, rather than Ecosystem.
  const relative = normalized.slice(at + CONTENT_ROOT.length)
  const software = getDocumentedSoftware(`/${relative}`)
  if (!software) return null
  const collection = software.path.slice(1)
  const folder = relative.slice(collection.length + 1).split('/')[0]
  if (!folder) return null

  const version = software.versions.find((entry) => entry.folder === folder)
  if (!version) return null

  return {
    collection,
    software,
    version,
    current: isCurrentLineFolder(version.folder),
  }
}
