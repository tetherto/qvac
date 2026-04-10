import { describe, it, expect } from 'vitest'
import {
  stripEmoji,
  normalizeCategory,
  isKnownCategory,
  escapeRegExp,
  extractVersionBlock,
  parseVersionBlock,
  mergeChangelogs,
  parseOverridesContent,
  CATEGORY_ORDER,
  type PackageChangelog,
} from '../scripts/lib/changelog-parser'

// ---------------------------------------------------------------------------
// stripEmoji
// ---------------------------------------------------------------------------

describe('stripEmoji', () => {
  it('removes emoji presentation characters', () => {
    expect(stripEmoji('\u{1F41B} Bug Fixes')).toBe('Bug Fixes')
  })

  it('returns plain text unchanged', () => {
    expect(stripEmoji('Bug Fixes')).toBe('Bug Fixes')
  })

  it('trims surrounding whitespace', () => {
    expect(stripEmoji('  Features  ')).toBe('Features')
  })

  it('handles empty string', () => {
    expect(stripEmoji('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// normalizeCategory
// ---------------------------------------------------------------------------

describe('normalizeCategory', () => {
  it('maps known aliases to canonical names', () => {
    expect(normalizeCategory('fixes')).toBe('Bug Fixes')
    expect(normalizeCategory('fixed')).toBe('Bug Fixes')
    expect(normalizeCategory('bug fixes')).toBe('Bug Fixes')
    expect(normalizeCategory('docs')).toBe('Documentation')
    expect(normalizeCategory('tests')).toBe('Testing')
    expect(normalizeCategory('new apis')).toBe('Features')
    expect(normalizeCategory('api changes')).toBe('API')
  })

  it('is case-insensitive', () => {
    expect(normalizeCategory('BUG FIXES')).toBe('Bug Fixes')
    expect(normalizeCategory('Breaking Changes')).toBe('Breaking Changes')
  })

  it('strips emoji before lookup', () => {
    expect(normalizeCategory('\u{1F41B} Bug Fixes')).toBe('Bug Fixes')
  })

  it('returns original text for unknown categories', () => {
    expect(normalizeCategory('Performance')).toBe('Performance')
    expect(normalizeCategory('Refactoring')).toBe('Refactoring')
  })
})

// ---------------------------------------------------------------------------
// isKnownCategory
// ---------------------------------------------------------------------------

describe('isKnownCategory', () => {
  it('returns true for mapped categories', () => {
    expect(isKnownCategory('Bug Fixes')).toBe(true)
    expect(isKnownCategory('fixes')).toBe(true)
    expect(isKnownCategory('docs')).toBe(true)
  })

  it('returns false for unmapped categories', () => {
    expect(isKnownCategory('Performance')).toBe(false)
    expect(isKnownCategory('Refactoring')).toBe(false)
  })

  it('strips emoji before checking', () => {
    expect(isKnownCategory('\u{1F41B} Bug Fixes')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// escapeRegExp
// ---------------------------------------------------------------------------

describe('escapeRegExp', () => {
  it('escapes regex special characters', () => {
    expect(escapeRegExp('1.0.0')).toBe('1\\.0\\.0')
    expect(escapeRegExp('a+b')).toBe('a\\+b')
    expect(escapeRegExp('(test)')).toBe('\\(test\\)')
    expect(escapeRegExp('[0]')).toBe('\\[0\\]')
  })

  it('leaves plain alphanumeric strings unchanged', () => {
    expect(escapeRegExp('abc123')).toBe('abc123')
  })
})

// ---------------------------------------------------------------------------
// extractVersionBlock — standard Keep a Changelog format
// ---------------------------------------------------------------------------

describe('extractVersionBlock', () => {
  const multiVersionChangelog = [
    '# Changelog',
    '',
    '## [2.0.0] - 2026-03-01',
    '',
    '### Breaking Changes',
    '',
    '- Removed legacy API',
    '',
    '## [1.0.0] - 2026-01-15',
    '',
    '### Features',
    '',
    '- Initial release',
    '',
    '## [0.9.0] - 2025-12-01',
    '',
    '### Bug Fixes',
    '',
    '- Fixed startup crash',
  ].join('\n')

  it('extracts block from heading with date', () => {
    const block = extractVersionBlock(multiVersionChangelog, '1.0.0')
    expect(block).not.toBeNull()
    expect(block).toContain('### Features')
    expect(block).toContain('Initial release')
  })

  it('stops at next version heading', () => {
    const block = extractVersionBlock(multiVersionChangelog, '2.0.0')
    expect(block).not.toBeNull()
    expect(block).toContain('Removed legacy API')
    expect(block).not.toContain('Initial release')
  })

  it('returns last version block when it is the final section', () => {
    const block = extractVersionBlock(multiVersionChangelog, '0.9.0')
    expect(block).not.toBeNull()
    expect(block).toContain('Fixed startup crash')
  })

  it('extracts block from heading without date', () => {
    const content = [
      '## [1.0.0]',
      '',
      '### Added',
      '',
      '- Something new',
    ].join('\n')
    const block = extractVersionBlock(content, '1.0.0')
    expect(block).toContain('Something new')
  })

  it('returns null when version is not present', () => {
    expect(extractVersionBlock(multiVersionChangelog, '3.0.0')).toBeNull()
  })

  it('returns null when content has no version headings at all', () => {
    expect(extractVersionBlock('Just some text\nNo versions here', '1.0.0')).toBeNull()
  })

  it('handles versions containing regex special chars', () => {
    const content = '## [1.0.0+build.1]\n\n- Build metadata entry'
    const block = extractVersionBlock(content, '1.0.0+build.1')
    expect(block).toContain('Build metadata entry')
  })

  it('does not match partial version numbers', () => {
    const content = [
      '## [1.0.0] - 2026-01-01',
      '',
      '- Version one',
      '',
      '## [1.0.0-beta] - 2025-12-01',
      '',
      '- Beta stuff',
    ].join('\n')
    const block = extractVersionBlock(content, '1.0.0')
    expect(block).not.toBeNull()
    expect(block).toContain('Version one')
    expect(block).not.toContain('Beta stuff')
  })
})

// ---------------------------------------------------------------------------
// parseVersionBlock — section parsing
// ---------------------------------------------------------------------------

describe('parseVersionBlock', () => {
  it('parses standard category sections into normalized categories', () => {
    const block = [
      '### Bug Fixes',
      '',
      '- Fixed a thing',
      '',
      '### Features',
      '',
      '- Added a thing',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toEqual({ category: 'Bug Fixes', content: '- Fixed a thing' })
    expect(sections[1]).toEqual({ category: 'Features', content: '- Added a thing' })
  })

  it('collects preamble text before first section heading', () => {
    const block = [
      'This release is a big one.',
      '',
      '### Added',
      '',
      '- New feature',
    ].join('\n')

    const { preamble, sections } = parseVersionBlock(block)
    expect(preamble).toBe('This release is a big one.')
    expect(sections).toHaveLength(1)
  })

  it('drops empty sections (no content between headings)', () => {
    const block = [
      '### Bug Fixes',
      '',
      '### Features',
      '',
      '- Actual content here',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Features')
  })

  it('strips horizontal rules from preamble', () => {
    const block = [
      'Some intro text',
      '---',
      '### Added',
      '',
      '- New thing',
    ].join('\n')

    const { preamble } = parseVersionBlock(block)
    expect(preamble).not.toContain('---')
    expect(preamble).toBe('Some intro text')
  })

  it('strips trailing horizontal rules from sections', () => {
    const block = [
      '### Bug Fixes',
      '',
      '- Fixed bug',
      '---',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections[0].content).toBe('- Fixed bug')
  })

  it('normalizes emoji-prefixed headings', () => {
    const block = [
      '### \u{1F41B} Bug Fixes',
      '',
      '- Fixed crash',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Bug Fixes')
  })

  it('normalizes alias headings', () => {
    const block = [
      '### Fixes',
      '',
      '- Patched leak',
      '',
      '### Docs',
      '',
      '- Updated README',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections[0].category).toBe('Bug Fixes')
    expect(sections[1].category).toBe('Documentation')
  })

  it('ignores sub-headings that look like version numbers', () => {
    const block = [
      '### Added',
      '',
      '- New feature',
      '',
      '## [0.9.0]',
      '',
      'Trailing text after skipped heading',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Added')
    expect(sections[0].content).toContain('- New feature')
    expect(sections[0].content).toContain('Trailing text after skipped heading')
  })

  it('passes through unknown category headings as-is into preamble when before known sections', () => {
    const block = [
      '## Custom Heading',
      '',
      'Custom content',
      '',
      '### Features',
      '',
      '- A feature',
    ].join('\n')

    const { preamble, sections } = parseVersionBlock(block)
    expect(preamble).toContain('Custom Heading')
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Features')
  })

  it('nests unknown headings under current known section', () => {
    const block = [
      '### Features',
      '',
      '- A feature',
      '',
      '### Custom Sub-heading',
      '',
      '- Sub-content',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toContain('### Custom Sub-heading')
    expect(sections[0].content).toContain('- Sub-content')
  })

  it('returns only preamble when block has no known sections', () => {
    const block = 'Just some notes about this release.\nNothing categorized.'

    const { preamble, sections } = parseVersionBlock(block)
    expect(preamble).toBe('Just some notes about this release.\nNothing categorized.')
    expect(sections).toHaveLength(0)
  })

  it('handles ## and ### headings for sections', () => {
    const block = [
      '## Bug Fixes',
      '',
      '- Fix from h2',
      '',
      '### Features',
      '',
      '- Feature from h3',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(2)
    expect(sections[0].category).toBe('Bug Fixes')
    expect(sections[1].category).toBe('Features')
  })
})

// ---------------------------------------------------------------------------
// mergeChangelogs — multiple packages with overlapping versions
// ---------------------------------------------------------------------------

describe('mergeChangelogs', () => {
  it('merges sections from multiple packages under same category', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: [{ category: 'Bug Fixes', content: '- SDK fix' }],
      },
      {
        pkg: 'cli',
        preamble: '',
        sections: [{ category: 'Bug Fixes', content: '- CLI fix' }],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe('Bug Fixes')
    expect(merged[0].packages).toHaveLength(2)
    expect(merged[0].packages[0]).toEqual({ pkg: 'sdk', content: '- SDK fix' })
    expect(merged[0].packages[1]).toEqual({ pkg: 'cli', content: '- CLI fix' })
  })

  it('preserves CATEGORY_ORDER priority ordering', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: [
          { category: 'Bug Fixes', content: '- fix' },
          { category: 'Features', content: '- feat' },
          { category: 'Breaking Changes', content: '- break' },
        ],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    const names = merged.map(c => c.name)
    expect(names).toEqual(['Breaking Changes', 'Features', 'Bug Fixes'])
  })

  it('sorts non-standard categories alphabetically after ordered ones', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: [
          { category: 'Bug Fixes', content: '- fix' },
          { category: 'Zebra', content: '- z' },
          { category: 'Alpha', content: '- a' },
        ],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    const names = merged.map(c => c.name)
    expect(names).toEqual(['Bug Fixes', 'Alpha', 'Zebra'])
  })

  it('returns empty array for empty input', () => {
    expect(mergeChangelogs([])).toEqual([])
  })

  it('handles single package with no merge needed', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'rag',
        preamble: '',
        sections: [{ category: 'Features', content: '- RAG feature' }],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    expect(merged).toHaveLength(1)
    expect(merged[0].packages).toHaveLength(1)
    expect(merged[0].packages[0].pkg).toBe('rag')
  })

  it('preserves each package entry separately within a category', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: [{ category: 'Features', content: '- SDK feat' }],
      },
      {
        pkg: 'cli',
        preamble: '',
        sections: [{ category: 'Features', content: '- CLI feat' }],
      },
      {
        pkg: 'rag',
        preamble: '',
        sections: [{ category: 'Features', content: '- RAG feat' }],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    expect(merged[0].packages).toHaveLength(3)
    expect(merged[0].packages.map(p => p.pkg)).toEqual(['sdk', 'cli', 'rag'])
  })

  it('handles package with zero sections', () => {
    const changelogs: PackageChangelog[] = [
      { pkg: 'sdk', preamble: 'Just a note', sections: [] },
      {
        pkg: 'cli',
        preamble: '',
        sections: [{ category: 'Features', content: '- CLI feat' }],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    expect(merged).toHaveLength(1)
    expect(merged[0].packages).toHaveLength(1)
    expect(merged[0].packages[0].pkg).toBe('cli')
  })

  it('handles multiple packages with different categories each', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: [{ category: 'Features', content: '- SDK feature' }],
      },
      {
        pkg: 'cli',
        preamble: '',
        sections: [{ category: 'Bug Fixes', content: '- CLI fix' }],
      },
      {
        pkg: 'logging',
        preamble: '',
        sections: [{ category: 'Documentation', content: '- Logging docs' }],
      },
    ]

    const merged = mergeChangelogs(changelogs)
    const names = merged.map(c => c.name)
    expect(names).toEqual(['Features', 'Bug Fixes', 'Documentation'])
  })

  it('covers all CATEGORY_ORDER entries when present', () => {
    const changelogs: PackageChangelog[] = [
      {
        pkg: 'sdk',
        preamble: '',
        sections: CATEGORY_ORDER.map(cat => ({
          category: cat,
          content: `- ${cat} item`,
        })),
      },
    ]

    const merged = mergeChangelogs(changelogs)
    expect(merged.map(c => c.name)).toEqual(CATEGORY_ORDER)
  })
})

// ---------------------------------------------------------------------------
// parseOverridesContent — overrides merge behavior
// ---------------------------------------------------------------------------

describe('parseOverridesContent', () => {
  it('parses ## headings into { heading, content } pairs', () => {
    const content = [
      '## Migration Guide',
      '',
      'Follow these steps to migrate.',
      '',
      '## Known Issues',
      '',
      'Issue A is not yet resolved.',
    ].join('\n')

    const sections = parseOverridesContent(content)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toEqual({
      heading: 'Migration Guide',
      content: 'Follow these steps to migrate.',
    })
    expect(sections[1]).toEqual({
      heading: 'Known Issues',
      content: 'Issue A is not yet resolved.',
    })
  })

  it('ignores content before first ## heading', () => {
    const content = [
      'Some preamble text that should be ignored.',
      '',
      '## Actual Section',
      '',
      'Section content.',
    ].join('\n')

    const sections = parseOverridesContent(content)
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('Actual Section')
  })

  it('drops sections with empty body', () => {
    const content = [
      '## Empty Section',
      '',
      '## Non-empty Section',
      '',
      'Has content.',
    ].join('\n')

    const sections = parseOverridesContent(content)
    expect(sections).toHaveLength(1)
    expect(sections[0].heading).toBe('Non-empty Section')
  })

  it('returns empty array for empty string', () => {
    expect(parseOverridesContent('')).toEqual([])
  })

  it('returns empty array for content with no ## headings', () => {
    expect(parseOverridesContent('Just text\nNo headings')).toEqual([])
  })

  it('handles multiple consecutive sections', () => {
    const content = [
      '## A',
      'Content A',
      '## B',
      'Content B',
      '## C',
      'Content C',
    ].join('\n')

    const sections = parseOverridesContent(content)
    expect(sections).toHaveLength(3)
    expect(sections.map(s => s.heading)).toEqual(['A', 'B', 'C'])
  })

  it('preserves multiline content within sections', () => {
    const content = [
      '## Details',
      '',
      'Line one.',
      'Line two.',
      '',
      '- Bullet point',
    ].join('\n')

    const sections = parseOverridesContent(content)
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe('Line one.\nLine two.\n\n- Bullet point')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: full changelog parsing + merge
// ---------------------------------------------------------------------------

describe('end-to-end: parse and merge', () => {
  const sdkChangelog = [
    '# Changelog',
    '',
    '## [0.8.0] - 2026-03-15',
    '',
    'Major overhaul of the SDK.',
    '',
    '### Breaking Changes',
    '',
    '- `loadModel` signature changed',
    '',
    '### Features',
    '',
    '- Added streaming completions',
    '',
    '### Bug Fixes',
    '',
    '- Fixed memory leak on model unload',
    '',
    '## [0.7.0] - 2026-01-10',
    '',
    '### Features',
    '',
    '- Initial streaming support',
  ].join('\n')

  const cliChangelog = [
    '# Changelog',
    '',
    '## [0.8.0] - 2026-03-15',
    '',
    '### Features',
    '',
    '- New `qvac run` command',
    '',
    '### Bug Fixes',
    '',
    '- Fixed config path resolution on Windows',
    '',
    '## [0.7.0] - 2026-01-10',
    '',
    '### Chores',
    '',
    '- Updated dependencies',
  ].join('\n')

  it('extracts matching version from multiple changelogs and merges', () => {
    const sdkBlock = extractVersionBlock(sdkChangelog, '0.8.0')!
    const cliBlock = extractVersionBlock(cliChangelog, '0.8.0')!

    const sdkParsed = parseVersionBlock(sdkBlock)
    const cliParsed = parseVersionBlock(cliBlock)

    const changelogs: PackageChangelog[] = [
      { pkg: 'sdk', ...sdkParsed },
      { pkg: 'cli', ...cliParsed },
    ]

    const merged = mergeChangelogs(changelogs)
    const names = merged.map(c => c.name)

    expect(names).toEqual(['Breaking Changes', 'Features', 'Bug Fixes'])

    const features = merged.find(c => c.name === 'Features')!
    expect(features.packages).toHaveLength(2)
    expect(features.packages[0].pkg).toBe('sdk')
    expect(features.packages[1].pkg).toBe('cli')
  })

  it('collects preamble from version block', () => {
    const sdkBlock = extractVersionBlock(sdkChangelog, '0.8.0')!
    const { preamble } = parseVersionBlock(sdkBlock)
    expect(preamble).toBe('Major overhaul of the SDK.')
  })

  it('returns null for version that does not exist in changelog', () => {
    expect(extractVersionBlock(sdkChangelog, '99.0.0')).toBeNull()
  })

  it('handles version present in one changelog but not another', () => {
    const sdkBlock = extractVersionBlock(sdkChangelog, '0.7.0')!
    const cliBlock = extractVersionBlock(cliChangelog, '0.7.0')!

    const sdkParsed = parseVersionBlock(sdkBlock)
    const cliParsed = parseVersionBlock(cliBlock)

    const changelogs: PackageChangelog[] = [
      { pkg: 'sdk', ...sdkParsed },
      { pkg: 'cli', ...cliParsed },
    ]

    const merged = mergeChangelogs(changelogs)
    const names = merged.map(c => c.name)

    expect(names).toEqual(['Features', 'Chores'])
    expect(merged.find(c => c.name === 'Features')!.packages).toHaveLength(1)
    expect(merged.find(c => c.name === 'Chores')!.packages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Malformed entries (cross-cutting edge cases)
// ---------------------------------------------------------------------------

describe('malformed entries', () => {
  it('extractVersionBlock returns null for completely empty content', () => {
    expect(extractVersionBlock('', '1.0.0')).toBeNull()
  })

  it('parseVersionBlock handles empty string input', () => {
    const { preamble, sections } = parseVersionBlock('')
    expect(preamble).toBe('')
    expect(sections).toHaveLength(0)
  })

  it('parseVersionBlock handles block with only whitespace', () => {
    const { preamble, sections } = parseVersionBlock('   \n  \n   ')
    expect(sections).toHaveLength(0)
  })

  it('parseVersionBlock handles interleaved unknown and known headings', () => {
    const block = [
      '### Performance',
      '',
      '- 2x faster',
      '',
      '### Bug Fixes',
      '',
      '- Fixed crash',
      '',
      '### Custom Category',
      '',
      '- Custom item',
    ].join('\n')

    const { preamble, sections } = parseVersionBlock(block)
    expect(preamble).toContain('Performance')
    expect(preamble).toContain('2x faster')
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Bug Fixes')
    expect(sections[0].content).toContain('- Fixed crash')
    expect(sections[0].content).toContain('### Custom Category')
    expect(sections[0].content).toContain('- Custom item')
  })

  it('parseVersionBlock handles consecutive known headings with no content', () => {
    const block = [
      '### Bug Fixes',
      '### Features',
      '### Added',
      '',
      '- Only this section has content',
    ].join('\n')

    const { sections } = parseVersionBlock(block)
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe('Added')
  })

  it('extractVersionBlock ignores headings without bracket-version format', () => {
    const content = [
      '## Version 1.0.0',
      '',
      '- This uses a non-standard heading',
    ].join('\n')

    expect(extractVersionBlock(content, '1.0.0')).toBeNull()
  })

  it('mergeChangelogs with all packages having empty sections', () => {
    const changelogs: PackageChangelog[] = [
      { pkg: 'sdk', preamble: 'note', sections: [] },
      { pkg: 'cli', preamble: '', sections: [] },
    ]

    expect(mergeChangelogs(changelogs)).toEqual([])
  })
})
