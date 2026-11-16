import { describe, expect, it } from 'vitest'
import { pointApiLinks, rewrittenDiff } from '../scripts/port-unpublished'

describe('porting the former unpublished content', () => {
  it('moves each diff path to the documentation root that replaced its folder', () => {
    const diff = [
      'diff --git a/docs/website/content/_unpublished/sdk/next/index.mdx b/docs/website/content/_unpublished/sdk/next/index.mdx',
      '--- a/docs/website/content/_unpublished/sdk/next/index.mdx',
      '+++ b/docs/website/content/_unpublished/sdk/next/index.mdx',
      '+++ b/docs/website/content/_unpublished/cli/next/index.mdx',
    ].join('\n')
    expect(rewrittenDiff(diff)).toBe(
      [
        'diff --git a/packages/sdk/docs/users/index.mdx b/packages/sdk/docs/users/index.mdx',
        '--- a/packages/sdk/docs/users/index.mdx',
        '+++ b/packages/sdk/docs/users/index.mdx',
        '+++ b/packages/cli/docs/users/index.mdx',
      ].join('\n'),
    )
  })

  it('points links to the former API page at each function page, and names the ones it cannot place', () => {
    const { text, unknown } = pointApiLinks(
      'See [`loadModel()`](/sdk/reference/api#loadmodel) and [types](/sdk/reference/api#completionrun).',
      ['loadModel', 'completion'],
    )
    expect(text).toBe('See [`loadModel()`](/sdk/reference/api/loadModel) and [types](/sdk/reference/api#completionrun).')
    expect(unknown).toEqual(['completionrun'])
  })
})
