/**
 * What the line switcher does with every page the site publishes.
 *
 * Two halves, as with the structure gate. The first states the rules against
 * synthetic lines — the label, the positional equivalence, the fallback — so
 * each is shown holding on its own. The second replays them over the real
 * content tree: every page of every line is switched into every other line,
 * and each destination has to be a page that exists, inside the line that was
 * asked for. That is the build-time check the navigation spec requires, and it
 * fails when a line loses its index or a folder group is renamed without the
 * manifest following.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import {
  collectionLines,
  collectionOfPath,
  destinationsFor,
  lineTitle,
  type CollectionLines,
} from '@/lib/lines'

const contentRoot = path.resolve(__dirname, '..', 'content', 'docs')

/** The URL a content file is served at, as the loader derives it. */
function urlOfFile(relative: string): string {
  const segments = relative
    .replace(/\.mdx?$/, '')
    .split('/')
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
  if (segments.at(-1) === 'index') segments.pop()
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/'
}

function contentUrls(): string[] {
  const urls: string[] = []
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relative)
      } else if (/\.mdx?$/.test(entry.name)) {
        urls.push(urlOfFile(relative))
      }
    }
  }
  walk(contentRoot, '')
  return urls
}

const synthetic: CollectionLines = {
  path: '/sdk',
  lines: [
    {
      version: 'v0.17',
      current: true,
      title: 'v0.17 (latest)',
      index: '/sdk/',
      urls: ['/sdk', '/sdk/quickstart', '/sdk/guides/streaming'],
    },
    {
      version: 'v0.16',
      current: false,
      title: 'v0.16',
      index: '/sdk/v0.16/',
      urls: ['/sdk/v0.16', '/sdk/v0.16/quickstart'],
    },
  ],
}

function destination(pathname: string, version: string): string {
  const found = destinationsFor(synthetic, pathname).find(
    (entry) => entry.line.version === version,
  )
  if (!found) throw new Error(`no line ${version}`)
  return found.url
}

describe('the line label', () => {
  it('marks the current line and leaves every other bare', () => {
    expect(lineTitle('v0.17', true)).toBe('v0.17 (latest)')
    expect(lineTitle('v0.16', false)).toBe('v0.16')
  })
})

describe('switching lines', () => {
  it('lands on the same path within the target line', () => {
    expect(destination('/sdk/quickstart/', 'v0.16')).toBe('/sdk/v0.16/quickstart')
    expect(destination('/sdk/v0.16/quickstart/', 'v0.17')).toBe('/sdk/quickstart')
  })

  it('lands on the line index when the target line lacks the page', () => {
    expect(destination('/sdk/guides/streaming/', 'v0.16')).toBe('/sdk/v0.16/')
  })

  it('keeps the reader in place when the target is their own line', () => {
    expect(destination('/sdk/quickstart/', 'v0.17')).toBe('/sdk/quickstart')
  })

  it('moves between the collection indexes', () => {
    expect(destination('/sdk/', 'v0.16')).toBe('/sdk/v0.16')
    expect(destination('/sdk/v0.16/', 'v0.17')).toBe('/sdk')
  })

  it('offers nothing outside a versioned collection', () => {
    expect(collectionOfPath([synthetic], '/ecosystem/architecture')).toBeNull()
  })
})

describe('switching lines inside a package documented in Ecosystem', () => {
  const pkg: CollectionLines = {
    path: '/ecosystem/packages/translation-nmtcpp',
    lines: [
      {
        version: 'v1.4',
        current: true,
        title: lineTitle('v1.4', true),
        index: '/ecosystem/packages/translation-nmtcpp/',
        urls: ['/ecosystem/packages/translation-nmtcpp', '/ecosystem/packages/translation-nmtcpp/usage'],
      },
      {
        version: 'v1.3',
        current: false,
        title: lineTitle('v1.3', false),
        index: '/ecosystem/packages/translation-nmtcpp/v1.3/',
        urls: ['/ecosystem/packages/translation-nmtcpp/v1.3'],
      },
    ],
  }
  const ecosystemWide: CollectionLines = { path: '/ecosystem', lines: [] }

  it('resolves a package page to the package, not to a shorter path around it', () => {
    expect(collectionOfPath([ecosystemWide, pkg], '/ecosystem/packages/translation-nmtcpp/usage')).toBe(pkg)
  })

  it('serves the newest line version-less and the others under their version', () => {
    const fromCurrent = destinationsFor(pkg, '/ecosystem/packages/translation-nmtcpp/usage')
    expect(fromCurrent.map(({ url }) => url)).toEqual([
      '/ecosystem/packages/translation-nmtcpp/usage',
      '/ecosystem/packages/translation-nmtcpp/v1.3/',
    ])
  })
})

describe('every page of every line', () => {
  const urls = contentUrls()
  const published = new Set(urls)
  // A collection the manifest declares but whose content is not cut into
  // lines yet has nothing to switch between. `line-structure.test.ts` owns
  // that case and names the folder that is missing; repeating it here would
  // only report the same cut twice, in worse terms.
  const collections = collectionLines(urls).filter((collection) =>
    collection.lines.every((line) => line.urls.length > 0),
  )

  it('finds a line for each collection that has been cut', () => {
    expect(collections.length).toBeGreaterThan(0)
    for (const collection of collections) {
      expect(collection.lines.length).toBeGreaterThan(0)
    }
  })

  it('switches into a page the site publishes, inside the line asked for', () => {
    for (const collection of collections) {
      for (const line of collection.lines) {
        for (const pathname of line.urls) {
          for (const { line: target, url } of destinationsFor(
            collection,
            pathname,
          )) {
            const landed = url.replace(/\/$/, '') || '/'
            expect(
              published.has(landed),
              `${pathname} → ${target.version} lands on ${url}, which is not published`,
            ).toBe(true)
            expect(
              target.urls.includes(landed),
              `${pathname} → ${target.version} lands on ${url}, outside that line`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('prefers the equivalent page over the line index whenever it exists', () => {
    for (const collection of collections) {
      for (const line of collection.lines) {
        for (const pathname of line.urls) {
          const prefix = line.current
            ? collection.path
            : `${collection.path}/${line.version}`
          const rest = pathname.slice(prefix.length)

          for (const { line: target, url } of destinationsFor(
            collection,
            pathname,
          )) {
            const equivalent = target.current
              ? `${collection.path}${rest}`
              : `${collection.path}/${target.version}${rest}`
            if (!published.has(equivalent)) continue
            expect(
              url.replace(/\/$/, '') || '/',
              `${pathname} → ${target.version} should reach ${equivalent}`,
            ).toBe(equivalent)
          }
        }
      }
    }
  })

  it('returns the reader to the page they left when they switch back', () => {
    for (const collection of collections) {
      for (const line of collection.lines) {
        for (const pathname of line.urls) {
          for (const { line: target, url } of destinationsFor(
            collection,
            pathname,
          )) {
            const back = destinationsFor(collection, url).find(
              (entry) => entry.line.version === line.version,
            )
            const landed = url.replace(/\/$/, '') || '/'
            // Only a switch that found its equivalent has a page to come back
            // from; a switch that fell back to the index comes back to the
            // origin line's index, which is the index's own destination.
            if (landed === (target.index.replace(/\/$/, '') || '/')) continue
            expect(back?.url.replace(/\/$/, '') || '/').toBe(pathname)
          }
        }
      }
    }
  })
})
