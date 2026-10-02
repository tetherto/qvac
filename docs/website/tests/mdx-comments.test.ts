import { describe, expect, it } from 'vitest';
import { stripMdxComments } from '../src/lib/mdx-comments';

/**
 * A comment renders as nothing, so every reader of a page as text has to see
 * nothing too. The cases below are the ones that bit: a passage parked beside
 * the one it replaces reads like real content, and both the link checker and
 * the Markdown twin took it for real content until they dropped comments.
 */
describe('stripMdxComments', () => {
  it('drops a single-line comment', () => {
    expect(stripMdxComments('before {/* parked */} after')).toBe(
      'before  after',
    );
  });

  it('drops a comment spanning lines, markup and links included', () => {
    const content = [
      'live paragraph',
      '{/*',
      '  Waiting on a release.',
      '  <Card href="/sdk/kotlin-sdk" title="Kotlin SDK" />',
      '*/}',
      'another live paragraph',
    ].join('\n');

    const stripped = stripMdxComments(content);
    expect(stripped).toContain('live paragraph');
    expect(stripped).toContain('another live paragraph');
    expect(stripped).not.toContain('kotlin-sdk');
    expect(stripped).not.toContain('Waiting on a release');
  });

  it('drops each comment separately rather than the span between two', () => {
    const content = '{/* first */}kept{/* second */}';
    expect(stripMdxComments(content)).toBe('kept');
  });

  it('leaves content without comments untouched', () => {
    const content = 'a [link](/sdk/quickstart) and an expression {value}';
    expect(stripMdxComments(content)).toBe(content);
  });
});
