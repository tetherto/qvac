// Relative, not aliased: this module is part of `source.config.ts`'s import
// graph, which the MDX config loader resolves outside the Next path aliases.
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { DOCUMENTED_SOFTWARE } from './versions'

/**
 * Roots the code imports of a materialized line at that line's own snapshot.
 *
 * Pages import their examples as `file=<rootDir>/packages/…`, with `<rootDir>`
 * the monorepo root. A line materialized from a pinned commit has its own copy
 * of those files under `.lines/<software>/<version>/`, extracted from the same
 * commit as its pages. This plugin rewrites the import to that copy, so an
 * older line shows the examples as they stood when it was released rather
 * than `main`'s.
 *
 * A line still held in place under `content/docs/` has no snapshot, and its
 * imports are left as written. Runs before `remark-code-import`.
 */

interface CodeNode {
  type: string
  meta?: string | null
  children?: CodeNode[]
}

const CONTENT_SEGMENT = '/content/docs/'
const ROOT_IMPORT = 'file=<rootDir>/'

/**
 * The snapshot directory of the line holding `filePath`, or null when the
 * file is not in a materialized line.
 */
export function snapshotRootOf(filePath: string, websiteRoot: string): string | null {
  const normalized = filePath.replaceAll('\\', '/')
  const at = normalized.lastIndexOf(CONTENT_SEGMENT)
  if (at === -1) return null
  const relative = normalized.slice(at + CONTENT_SEGMENT.length)

  const owners = DOCUMENTED_SOFTWARE.map((software) => software.path.slice(1))
    .filter((slug) => relative.startsWith(slug + '/'))
    .sort((a, b) => b.length - a.length)
  const slug = owners[0]
  if (!slug) return null

  const folder = relative.slice(slug.length + 1).split('/')[0]
  if (!folder) return null
  const version = folder.replace(/^\((.*)\)$/, '$1')
  const snapshot = path.join(websiteRoot, '.lines', slug, version)
  return existsSync(snapshot) ? snapshot : null
}

export default function remarkLineRoots(options: { websiteRoot: string; monorepoRoot: string }) {
  return (tree: CodeNode, file: { path?: string }) => {
    if (!file.path) return
    const snapshot = snapshotRootOf(path.resolve(file.path), options.websiteRoot)
    if (!snapshot) return
    const prefix = path.relative(options.monorepoRoot, snapshot).replaceAll('\\', '/')

    const visit = (node: CodeNode) => {
      if (node.type === 'code' && node.meta?.includes(ROOT_IMPORT)) {
        node.meta = node.meta.replaceAll(ROOT_IMPORT, `${ROOT_IMPORT}${prefix}/`)
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
