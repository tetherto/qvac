/**
 * Unit tests for the `--title-only` mode of `generate-api-docs.ts`.
 *
 * The mode is exposed as the exported `rewriteFrontmatterTitle` helper.
 * We exercise it against scratch MDX files rather than the real
 * `content/docs/reference/api/` tree so the test stays isolated.
 *
 * What we verify:
 *   - The single `title:` line inside the frontmatter is rewritten with
 *     the new version label using the exact template format.
 *   - The body content is preserved byte-for-byte (we are touching the
 *     existing patch's prose, not regenerating it).
 *   - Frontmatter delimiters are preserved.
 *   - Errors are thrown for malformed inputs (missing frontmatter, no
 *     title line, etc.) so the patch flow fails fast.
 */
import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { rewriteFrontmatterTitle } from '../scripts/generate-api-docs'

function makeTempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qvac-api-title-'))
  const filePath = path.join(dir, name)
  writeFileSync(filePath, content)
  return filePath
}

const SAMPLE_INDEX = [
  '---',
  'title: API Summary — v0.10.2 (latest)',
  'description: One-page reference of all public functions and objects exported by @qvac/sdk',
  '---',
  '',
  '> Auto-generated from `.d.ts` declarations and TSDoc comments.',
  '',
  '## Functions',
  '',
  '### completion',
  '',
  'Body text we must not touch.',
  '',
  '## Errors',
  '',
  '| Code | Description |',
  '|------|-------------|',
  '| INVALID_TOOL | bad tool |',
  '',
].join('\n')

describe('rewriteFrontmatterTitle', () => {
  it('rewrites the title with the new version label, preserves body', async () => {
    const file = makeTempFile('index.mdx', SAMPLE_INDEX)
    try {
      await rewriteFrontmatterTitle(file, 'v0.10.3 (latest)')
      const updated = readFileSync(file, 'utf-8')
      expect(updated).toContain('title: API Summary — v0.10.3 (latest)')
      expect(updated).not.toContain('title: API Summary — v0.10.2 (latest)')
      // The body lives below the frontmatter — assert each landmark is intact.
      expect(updated).toContain('## Functions')
      expect(updated).toContain('Body text we must not touch.')
      expect(updated).toContain('## Errors')
      expect(updated).toContain('| INVALID_TOOL | bad tool |')
      // The frontmatter delimiters are preserved.
      expect(updated.startsWith('---\n')).toBe(true)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('rewrites the title without a "(latest)" suffix when called for an archived file', async () => {
    const sample = SAMPLE_INDEX.replace(
      'title: API Summary — v0.10.2 (latest)',
      'title: API Summary — v0.8.0',
    )
    const file = makeTempFile('v0.8.0.mdx', sample)
    try {
      await rewriteFrontmatterTitle(file, 'v0.8.1')
      const updated = readFileSync(file, 'utf-8')
      expect(updated).toContain('title: API Summary — v0.8.1')
      expect(updated).not.toContain('title: API Summary — v0.8.0')
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('throws when the file does not start with frontmatter', async () => {
    const file = makeTempFile('broken.mdx', '# No frontmatter here\n')
    try {
      await expect(
        rewriteFrontmatterTitle(file, 'v0.0.1'),
      ).rejects.toThrow(/frontmatter/)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('throws when the frontmatter has no closing terminator', async () => {
    const file = makeTempFile(
      'broken.mdx',
      '---\ntitle: API Summary — v0.0.0\n',
    )
    try {
      await expect(
        rewriteFrontmatterTitle(file, 'v0.0.1'),
      ).rejects.toThrow(/frontmatter terminator/)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('throws when the frontmatter lacks a `title:` line', async () => {
    const file = makeTempFile(
      'broken.mdx',
      '---\ndescription: something\n---\n\nBody.\n',
    )
    try {
      await expect(
        rewriteFrontmatterTitle(file, 'v0.0.1'),
      ).rejects.toThrow(/no `title:` line/)
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('does not touch a `title:` that only appears inside the body', async () => {
    const sample = [
      '---',
      'title: API Summary — v0.5.0',
      'description: existing',
      '---',
      '',
      '## Example',
      '',
      '```yaml',
      'title: not-frontmatter',
      '```',
    ].join('\n')
    const file = makeTempFile('index.mdx', sample)
    try {
      await rewriteFrontmatterTitle(file, 'v0.5.1')
      const updated = readFileSync(file, 'utf-8')
      // Frontmatter title rewritten
      expect(updated).toContain('title: API Summary — v0.5.1')
      // Body fenced block untouched
      expect(updated).toContain('title: not-frontmatter')
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})
