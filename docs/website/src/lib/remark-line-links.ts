// Relative, not aliased: this module is part of `source.config.ts`'s import
// graph, which the MDX config loader resolves outside the Next path aliases.
import { versionOfFile } from './content-line'

/**
 * Resolves an internal link into the documentation line of the page that
 * carries it.
 *
 * Links are authored version-less everywhere — `/sdk/configuration/` — in the
 * current line and the older ones alike, so the two copies of a page differ
 * only where their content differs and a cut rewrites nothing. That leaves the
 * older line's links pointing at the current line, which would walk a reader
 * out of the release they are reading, one click at a time. This plugin closes
 * that gap at build time: a link from a page in `v0.16` to its own collection
 * becomes `/sdk/v0.16/…`.
 *
 * Only same-collection links move. A link to an unversioned page resolves
 * wherever that page lives, and a link to another versioned collection
 * resolves at that collection's current line, because no line of one
 * collection is pinned to a line of another.
 *
 * Both link surfaces are covered, because the content uses both: Markdown
 * links, and the `href` of a JSX component such as Fumadocs' `<Card>`.
 */

interface Node {
  type: string
  url?: string
  children?: Node[]
  attributes?: Array<{
    type: string
    name?: string
    value?: unknown
  }>
}

interface Line {
  /** The collection's URL prefix, without slashes: `sdk`. */
  collection: string
  /** The line's URL segment: `v0.16`. */
  segment: string
}

/**
 * The line a content file belongs to, or null when its links need no
 * resolution — the file is outside a versioned collection, or it belongs to
 * the current line, whose pages already answer the version-less paths.
 */
export function lineOfFile(filePath: string): Line | null {
  const line = versionOfFile(filePath)
  if (!line || line.current) return null
  return { collection: line.collection, segment: line.version.version }
}

/**
 * The link as the line serves it. Anything that is not an absolute path into
 * the same collection is returned untouched, including a link already
 * carrying the line, so running twice changes nothing.
 */
export function resolveLink(url: string, line: Line): string {
  if (!url.startsWith('/')) return url

  const [pathname, suffix] = splitSuffix(url)
  const prefix = `/${line.collection}`
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return url

  const rest = pathname.slice(prefix.length)
  if (rest === `/${line.segment}` || rest.startsWith(`/${line.segment}/`)) {
    return url
  }

  // A link to the collection lands on the line's index, whose last segment
  // carries the dot. The CDN reads that as a file request, so it reaches the
  // page from the trailing-slash form directly and from the slash-less one
  // through a redirect. Next normalizes the slash away again when it renders
  // the link — it reads a dotted segment as a file too — but nothing
  // normalizes the page's Markdown twin, where the better form survives.
  if (rest === '' || rest === '/') {
    return `${prefix}/${line.segment}/${suffix}`
  }

  return `${prefix}/${line.segment}${rest}${suffix}`
}

/** Splits `/a/b#c?d` into its path and everything the path ends at. */
function splitSuffix(url: string): [string, string] {
  const at = url.search(/[#?]/)
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at)]
}

function walk(node: Node, line: Line): void {
  if ((node.type === 'link' || node.type === 'definition') && node.url) {
    node.url = resolveLink(node.url, line)
  }

  for (const attribute of node.attributes ?? []) {
    if (attribute.name === 'href' && typeof attribute.value === 'string') {
      attribute.value = resolveLink(attribute.value, line)
    }
  }

  for (const child of node.children ?? []) {
    walk(child, line)
  }
}

export default function remarkLineLinks() {
  return (tree: Node, file: { path?: string }) => {
    const line = file.path ? lineOfFile(file.path) : null
    if (!line) return
    walk(tree, line)
  }
}
