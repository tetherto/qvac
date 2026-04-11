import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CONTENT_DIR = path.resolve(process.cwd(), 'content/docs')

vi.mock('@/lib/source', async () => {
  const { readdirSync, existsSync } = await import('node:fs')
  const { resolve, join } = await import('node:path')

  const contentDir = resolve(process.cwd(), 'content/docs')
  const children: Record<string, unknown>[] = []

  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const apiDir = join(contentDir, entry.name, 'sdk', 'api')
    if (!existsSync(apiDir)) continue

    const urlPrefix = entry.name === '(latest)' ? '' : `/${entry.name}`
    const folderChildren = readdirSync(apiDir)
      .filter((f: string) => f.endsWith('.mdx') && f !== 'index.mdx')
      .map((f: string) => ({
        type: 'page' as const,
        name: f.replace('.mdx', ''),
        url: `${urlPrefix}/sdk/api/${f.replace('.mdx', '')}`,
      }))

    children.push({
      type: 'folder',
      name: 'API',
      index: { type: 'page', name: 'API', url: `${urlPrefix}/sdk/api` },
      children: folderChildren,
    })
  }

  return { source: { pageTree: { children } } }
})

vi.mock('@/lib/resolveIcon', () => ({
  resolveIcon: () => undefined,
}))

import { getAllTrees } from '@/lib/trees'
import type { Node } from 'fumadocs-core/page-tree'

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

const trees = getAllTrees()
const versionPrefixes = Object.keys(trees).filter(k => k !== 'latest')

function getExpectedPaths (url: string): string[] {
  let cleanUrl = url.split('#')[0].replace(/^\//, '')

  let contentPrefix = '(latest)'
  for (const version of versionPrefixes) {
    if (cleanUrl.startsWith(version + '/') || cleanUrl === version) {
      contentPrefix = version
      cleanUrl = cleanUrl.slice(version.length).replace(/^\//, '')
      break
    }
  }

  if (!cleanUrl) {
    return [path.join(CONTENT_DIR, contentPrefix, 'index.mdx')]
  }

  return [
    path.join(CONTENT_DIR, contentPrefix, cleanUrl + '.mdx'),
    path.join(CONTENT_DIR, contentPrefix, cleanUrl, 'index.mdx'),
  ]
}

describe('sidebar-consistency', () => {
  describe.each(Object.entries(trees))('tree: %s', (_version, nodes) => {
    const urls = [...new Set(collectUrls(nodes as Node[]))]

    it.each(urls)('has content file for %s', (url) => {
      const candidates = getExpectedPaths(url)
      const found = candidates.some(p => fs.existsSync(p))
      expect(found, `No .mdx file for ${url}. Checked:\n  ${candidates.join('\n  ')}`).toBe(true)
    })
  })
})
