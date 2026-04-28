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

import { customTree } from '@/lib/custom-tree'
import type { Node } from 'fumadocs-core/page-tree'

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
 * For a sidebar URL like `/sdk/api`, the content file resolves to either:
 *   - `content/docs/sdk/api.mdx`, or
 *   - `content/docs/sdk/api/index.mdx`
 *
 * Anchor-only URLs (`/#community`) resolve against the docs root index.
 */
function getExpectedPaths (url: string): string[] {
  const cleanUrl = url.split('#')[0].replace(/^\//, '')
  if (!cleanUrl) {
    return [path.join(CONTENT_DIR, 'index.mdx')]
  }
  return [
    path.join(CONTENT_DIR, cleanUrl + '.mdx'),
    path.join(CONTENT_DIR, cleanUrl, 'index.mdx'),
  ]
}

describe('sidebar-consistency', () => {
  const urls = [...new Set(collectUrls(customTree as Node[]))]

  it.each(urls)('has content file for %s', (url) => {
    const candidates = getExpectedPaths(url)
    const found = candidates.some((p) => fs.existsSync(p))
    expect(found, `No .mdx file for ${url}. Checked:\n  ${candidates.join('\n  ')}`).toBe(true)
  })
})
