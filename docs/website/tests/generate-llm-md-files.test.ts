import { describe, it, expect } from 'vitest';
import { urlToMarkdownRelativePath } from '../scripts/generate-llm-md-files';

describe('urlToMarkdownRelativePath', () => {
  it('maps the home page to index.md', () => {
    expect(urlToMarkdownRelativePath('/')).toBe('index.md');
  });

  it('maps a top-level page to <slug>.md', () => {
    expect(urlToMarkdownRelativePath('/quickstart')).toBe('quickstart.md');
  });

  it('maps a nested page to <dir>/<slug>.md', () => {
    expect(urlToMarkdownRelativePath('/reference/api')).toBe('reference/api.md');
  });

  it('maps a deeply nested page', () => {
    expect(urlToMarkdownRelativePath('/addons/llm-llamacpp/index')).toBe(
      'addons/llm-llamacpp/index.md',
    );
  });

  it('tolerates trailing slashes', () => {
    expect(urlToMarkdownRelativePath('/quickstart/')).toBe('quickstart.md');
    expect(urlToMarkdownRelativePath('/reference/api/')).toBe(
      'reference/api.md',
    );
  });

  it('tolerates duplicate leading slashes', () => {
    expect(urlToMarkdownRelativePath('//quickstart')).toBe('quickstart.md');
  });

  it('throws on empty / missing url', () => {
    expect(() => urlToMarkdownRelativePath('')).toThrow();
    // @ts-expect-error — exercising runtime guard against non-string input
    expect(() => urlToMarkdownRelativePath(undefined)).toThrow();
  });
});
