// Relative imports only, so scripts and tests resolve it outside the Next
// path aliases.
import { DOCUMENTED_SOFTWARE, type DocumentedSoftware } from './versions'

/**
 * The redirect rules every documentation line needs, generated from the
 * versions files instead of written by hand, so publishing or retiring a
 * line is one edit to its versions file.
 *
 * `public/_redirects` holds two marker lines where these rules belong. The
 * build expands them into `out/_redirects`, the file the CDN reads; the
 * source file never carries a line's rules.
 */

export const PUBLISHED_MARKER = '# @generated documentation-lines'
export const RETIRED_MARKER = '# @generated retired-documentation-lines'

const COLUMNS = { source: 19, destination: 29 }

/** Pads a column, always leaving at least one space after a long value. */
function column(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width)
}

function rule(from: string, to: string, status: string): string {
  return column(from, COLUMNS.source) + column(to, COLUMNS.destination) + status
}

/**
 * The three rules of a line served under its own version segment. The CDN
 * reads a dotted segment as a file request and never normalizes its trailing
 * slash, so the root needs its own rewrite and redirect, and every page below
 * it needs the splat. With-slash rewrite first, then the bare redirect, then
 * the splat, so the root is answered by its own rules.
 */
export function publishedLineRules(path: string, version: string): string[] {
  const line = `${path}/${version}`
  return [
    rule(`${line}/`, `${line}/index.html`, '200'),
    rule(line, `${line}/`, '301'),
    rule(`${line}/*`, `${line}/:splat/index.html`, '200'),
  ]
}

/** The three rules sending a retired line's addresses to the current line. */
export function retiredLineRules(path: string, version: string): string[] {
  const line = `${path}/${version}`
  return [
    rule(`${line}/`, `${path}/`, '301'),
    rule(line, `${path}/`, '301'),
    rule(`${line}/*`, `${path}/:splat`, '301'),
  ]
}

/**
 * Every published line not served at the version-less paths: every line but
 * the current one of a user-facing software, and every version of an
 * internal-machinery package, whose version-less path is its index.
 */
export function publishedRules(software: readonly DocumentedSoftware[] = DOCUMENTED_SOFTWARE): string[] {
  return software.flatMap((entry) =>
    entry.versions
      .filter((version) => !version.folder.startsWith('('))
      .flatMap((version) => publishedLineRules(entry.path, version.version)),
  )
}

/** Every retired line, in the order each versions file lists them. */
export function retiredRules(software: readonly DocumentedSoftware[] = DOCUMENTED_SOFTWARE): string[] {
  return software.flatMap((entry) =>
    (entry.retired ?? []).flatMap((version) => retiredLineRules(entry.path, version)),
  )
}

/**
 * Expands both markers of a redirects file. Throws when a marker is missing,
 * because a file without one would silently publish lines the CDN cannot
 * serve.
 */
export function expandLineRedirects(
  source: string,
  software: readonly DocumentedSoftware[] = DOCUMENTED_SOFTWARE,
): string {
  const lines = source.split('\n')
  for (const marker of [PUBLISHED_MARKER, RETIRED_MARKER]) {
    if (lines.filter((text) => text.trim() === marker).length !== 1) {
      throw new Error(`_redirects must carry the marker \`${marker}\` exactly once`)
    }
  }
  return lines
    .flatMap((text) => {
      if (text.trim() === PUBLISHED_MARKER) return publishedRules(software)
      if (text.trim() === RETIRED_MARKER) return retiredRules(software)
      return [text]
    })
    .join('\n')
}
