import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CONTENT_DIR = path.resolve(process.cwd(), 'content/docs')

// resolveIcon imports `lucide-react` which only loads in a Next.js build.
// The sidebar tree imports it transitively, so we stub it here so the test
// can exercise the real tree without pulling the icon library.
vi.mock('@/lib/resolveIcon', () => ({
  resolveIcon: () => undefined,
}))

import { searchPath } from 'fumadocs-core/breadcrumb'
import { buildCustomTree } from '@/lib/custom-tree'
import { DOCUMENTED_SOFTWARE, getVersionForPath } from '@/lib/versions'
import type { Node, Root } from 'fumadocs-core/page-tree'

const PAGE_EXTENSIONS = ['.mdx', '.md']

/**
 * A page tree standing in for the one Fumadocs builds, carrying an empty
 * folder per documentation line the manifest declares.
 *
 * The composition only reads a line's children out of it, and those children
 * come from `meta.json` — checked directly against the content directory
 * below, where a missing entry names itself instead of vanishing into an
 * assertion about a composed tree.
 */
function linePageTree (): Root {
  const children: Node[] = DOCUMENTED_SOFTWARE
    .filter((software) => software.kind === 'collection')
    .flatMap((software) =>
      software.versions.map((line) => ({
        type: 'folder' as const,
        $id: `root:${software.path.slice(1)}/${line.folder}`,
        name: software.package,
        children: [],
      })),
    )
  return { $id: 'root', name: 'docs', children }
}

/**
 * Walk the tree and collect every internal page URL (skip external links,
 * pages with explicit hash-only anchors stay as-is — the page is still
 * required to exist).
 */
function collectUrls (nodes: Node[]): string[] {
  const urls: string[] = []
  for (const node of nodes) {
    if (node.type === 'page') {
      if (!node.external && !node.url.startsWith('http')) {
        urls.push(node.url)
      }
    } else if (node.type === 'folder') {
      if (node.index && !node.index.external && !node.index.url.startsWith('http')) {
        urls.push(node.index.url)
      }
      urls.push(...collectUrls(node.children))
    }
  }
  return urls
}

/**
 * The content paths a URL may resolve from. Inside a versioned collection the
 * URL says nothing about the folder: the current line answers version-less
 * and lives in a folder group (`sdk/(v0.17)/quickstart.mdx` serves
 * `/sdk/quickstart`), and an older line answers under its own segment. So the
 * line the URL belongs to is resolved from the manifest, and its folder
 * spliced in after the collection.
 *
 * The literal path stays a candidate too, for a collection whose content has
 * not been cut into lines yet. Which layout is the right one is the structure
 * check's question, not this one's — here an entry only has to name a page
 * that exists.
 */
function contentPaths (url: string): string[] {
  const cleanUrl = url.split('#')[0].replace(/^\//, '').replace(/\/$/, '')
  if (!cleanUrl) return ['index']

  const paths = [cleanUrl]

  const resolved = getVersionForPath('/' + cleanUrl)
  if (resolved && resolved.software.kind === 'collection') {
    const { software, version } = resolved
    const collection = software.path.slice(1)
    const rest = cleanUrl
      .slice(collection.length)
      .replace(/^\//, '')
      .replace(new RegExp(`^${version.version}(/|$)`), '')
    paths.push([collection, version.folder, rest].filter(Boolean).join('/'))
  }

  return paths
}

/**
 * For a sidebar URL like `/sdk/reference/api`, the content file resolves to
 * either `<line>/reference/api.mdx` or `<line>/reference/api/index.mdx`.
 *
 * Anchor-only URLs (`/#community`) resolve against the docs root index.
 *
 * A trailing slash is dropped first: a line entry carries one, because its
 * dotted slug (`v0.16`) needs it to resolve at the CDN.
 */
function getExpectedPaths (url: string): string[] {
  return contentPaths(url).flatMap((contentPath) =>
    contentPath === 'index'
      ? [path.join(CONTENT_DIR, 'index.mdx')]
      : PAGE_EXTENSIONS.flatMap((extension) => [
          path.join(CONTENT_DIR, contentPath + extension),
          path.join(CONTENT_DIR, contentPath, 'index' + extension),
        ]),
  )
}

/** Every directory under `content/docs` holding a `meta.json`. */
function metaDirectories (dir = CONTENT_DIR): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...metaDirectories(path.join(dir, entry.name)))
    else if (entry.name === 'meta.json') found.push(dir)
  }
  return found
}

function readPages (dir: string): string[] {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  return Array.isArray(meta.pages) ? meta.pages : []
}

const SEPARATOR = /^---(?:\[[^\]]+])?(.+)---$|^---$/
const LINK = /^(external:)?(?:\[[^\]]+])?\[[^\]]+]\(([^)]+)\)$/
const REST = new Set(['...', 'z...a'])

type Entry =
  | { kind: 'ignored' }
  | { kind: 'link', url: string }
  | { kind: 'page', name: string }
  | { kind: 'folder', name: string }

/**
 * Classify one `meta.json` entry the way Fumadocs resolves it: separators,
 * rest markers and exclusions name no content, a link names a URL, `...name`
 * names a folder whose children are spliced in, and anything else names a
 * page or a folder.
 */
function classify (entry: string): Entry {
  if (REST.has(entry) || SEPARATOR.test(entry)) return { kind: 'ignored' }

  const link = LINK.exec(entry)
  if (link) {
    const [, external, url] = link
    return external || url.startsWith('http') ? { kind: 'ignored' } : { kind: 'link', url }
  }

  if (entry.startsWith('!')) return { kind: 'ignored' }
  if (entry.startsWith('...')) return { kind: 'folder', name: entry.slice(3) }
  return { kind: 'page', name: entry }
}

function resolvesToPage (dir: string, name: string): boolean {
  return PAGE_EXTENSIONS.some((extension) => fs.existsSync(path.join(dir, name + extension)))
}

function resolvesToFolder (dir: string, name: string): boolean {
  const target = path.join(dir, name)
  return fs.existsSync(target) && fs.statSync(target).isDirectory()
}

describe('sidebar-consistency', () => {
  describe('entries declared in custom-tree', () => {
    const urls = [...new Set(collectUrls(buildCustomTree(linePageTree())))]

    it.each(urls)('has content file for %s', (url) => {
      const candidates = getExpectedPaths(url)
      const found = candidates.some((p) => fs.existsSync(p))
      expect(found, `No content file for ${url}. Checked:\n  ${candidates.join('\n  ')}`).toBe(true)
    })
  })

  describe('a departure does not shadow its target', () => {
    // A collection's sidebar is also what resolves a page's own collection:
    // the roots are searched in declaration order and the first page node
    // matching the pathname decides which root, and so which sidebar, the page
    // renders under. Ecosystem is declared first and points into the SDK and
    // the CLI, so a departure written without its trailing slash would win the
    // match for its own target and render that page under Ecosystem's sidebar.
    //
    // The slash is what makes a departure unmatchable: `searchPath` normalizes
    // the pathname it is given but not the URL it reads off the node.
    const tree = { $id: 'root', name: 'docs', children: buildCustomTree(linePageTree()) }

    // `/sdk` and `/cli` are root indexes, which this stub tree carries. The
    // model-provider page comes from a line's `meta.json`, which the stub
    // leaves empty, so it resolves to nothing here — and nothing is the right
    // answer: what must never happen is that it resolves under Ecosystem.
    const targets: Array<[string, string, boolean]> = [
      ['/sdk', 'SDK', true],
      ['/cli', 'CLI', true],
      ['/cli/http-server/connection', 'CLI', false],
    ]

    it.each(targets)('%s is never captured by a departure', (url, collection, carried) => {
      for (const pathname of [url, `${url}/`]) {
        const path = searchPath(tree.children, pathname) ?? []
        const roots = path.filter((node) => node.type === 'folder' && node.root)
        if (carried) {
          expect(roots.length, `${pathname} matches the tree under no root`).toBeGreaterThan(0)
        }
        const active = roots[roots.length - 1]
        if (active) {
          expect(
            active.name,
            `${pathname} resolves under the wrong collection — a departure is shadowing it`,
          ).toBe(collection)
        }
      }
    })
  })

  describe('every inventory page resolves to a root', () => {
    // The sidebar beside a page is the last root folder on the path Fumadocs
    // finds by matching the pathname against the tree — page URL against page
    // URL, with the pathname's trailing slash normalized away and the node's
    // left as written. A page the tree names nowhere, or names at a URL
    // carrying a slash, matches nothing, and the sidebar falls back to listing
    // the roots: the reader opens a README and is shown the collections.
    //
    // The inventory is where that bites, because it is the one part of the
    // tree whose entries are composed rather than read from a `meta.json`.
    const tree = { $id: 'root', name: 'docs', children: buildCustomTree(linePageTree()) }
    const urls = DOCUMENTED_SOFTWARE
      .filter((software) => software.kind === 'package')
      .flatMap((software) => [
        software.path,
        ...software.versions.map((version) => `${software.path}/${version.version}`),
      ])

    it.each(urls)('finds a sidebar for %s', (url) => {
      for (const pathname of [url, `${url}/`]) {
        const path = searchPath(tree.children, pathname) ?? []
        expect(path.length, `${pathname} matches nothing in the tree`).toBeGreaterThan(0)
        expect(
          path.some((node) => node.type === 'folder' && node.root),
          `${pathname} matches the tree but under no root, so the sidebar has nothing to scope to`,
        ).toBe(true)
      }
    })

    it('keeps versions out of the sidebar, leaving them to the switcher', () => {
      // What a sidebar renders is a root's children; a root's own index is not
      // an entry. So the versions may be named as indexes, and must not appear
      // among any root's children.
      const rendered = tree.children.flatMap((node) =>
        node.type === 'folder' ? collectUrls(node.children) : [],
      )

      expect(
        rendered.filter(
          (url) => url.startsWith('/ecosystem/inventory/') && /\/v\d+\.\d+$/.test(url),
        ),
      ).toEqual([])
    })
  })

  describe('entries declared in meta.json', () => {
    // Each line declares its own navigation, so an entry is only ever resolved
    // against its own directory. A page one line carries and another dropped
    // is two independent declarations, and neither is measured against the
    // other.
    const declarations = metaDirectories().flatMap((dir) =>
      readPages(dir).map((entry) => ({ dir, entry })),
    )

    it.each(declarations)('resolves $entry in $dir', ({ dir, entry }) => {
      const classified = classify(entry)
      if (classified.kind === 'ignored') return

      if (classified.kind === 'link') {
        const candidates = getExpectedPaths(classified.url)
        expect(
          candidates.some((p) => fs.existsSync(p)),
          `No content file for ${classified.url}. Checked:\n  ${candidates.join('\n  ')}`,
        ).toBe(true)
        return
      }

      const relative = path.relative(CONTENT_DIR, dir)
      if (classified.kind === 'folder') {
        expect(
          resolvesToFolder(dir, classified.name),
          `meta.json in ${relative} splices "${classified.name}", which is not a folder`,
        ).toBe(true)
        return
      }

      expect(
        resolvesToPage(dir, classified.name) || resolvesToFolder(dir, classified.name),
        `meta.json in ${relative} names "${classified.name}", which is neither a page nor a folder`,
      ).toBe(true)
    })
  })

  describe('content reachable from meta.json', () => {
    // A page no navigation names belongs to no collection: the sidebar falls
    // back to listing the collections, and the reader lands somewhere that
    // looks like a different site. Where a directory declares its pages, it
    // must declare all of them.
    const directories = metaDirectories()

    it.each(directories)('names every page and folder in %s', (dir) => {
      const entries = readPages(dir)
      if (entries.length === 0) return

      const named = new Set(
        entries.flatMap((entry) => {
          const classified = classify(entry)
          return classified.kind === 'page' || classified.kind === 'folder'
            ? [classified.name]
            : []
        }),
      )
      // An exclusion is a deliberate omission, and the index of a folder that
      // is not a root is lifted out of the list by Fumadocs itself.
      for (const entry of entries) {
        if (entry.startsWith('!')) named.add(entry.slice(1))
      }
      named.add('index')

      const missing = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((child) =>
          child.isDirectory() ||
          PAGE_EXTENSIONS.includes(path.extname(child.name)),
        )
        .map((child) =>
          child.isDirectory() ? child.name : path.basename(child.name, path.extname(child.name)),
        )
        .filter((name) => !named.has(name))

      expect(
        missing,
        `Unlisted in ${path.relative(CONTENT_DIR, dir)}/meta.json: ${missing.join(', ')}`,
      ).toEqual([])
    })
  })
})
