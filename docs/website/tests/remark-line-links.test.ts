import { describe, expect, it } from 'vitest'
import { lineOfFile, resolveLink } from '../src/lib/remark-line-links'

describe('links inside a documentation line', () => {
  it('resolves the unreleased preview line within itself', () => {
    const line = lineOfFile('/repo/docs/website/content/docs/sdk/preview/ai-capabilities/translation.mdx')
    expect(line).toEqual({ collection: 'sdk', segment: 'preview' })
    expect(resolveLink('/sdk/reference/api/translate/', line!)).toBe('/sdk/preview/reference/api/translate/')
  })

  it('leaves the current line alone, since it answers the version-less paths', () => {
    const current = '/repo/docs/website/content/docs/sdk/(v0.23)/index.mdx'
    expect(lineOfFile(current)).toBeNull()
  })

  it('leaves a link outside the collection alone', () => {
    expect(resolveLink('/cli/http-server', { collection: 'sdk', segment: 'preview' })).toBe('/cli/http-server')
  })
})
