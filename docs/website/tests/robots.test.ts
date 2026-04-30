import { describe, it, expect, afterEach, vi } from 'vitest';
import robots, { AI_BOT_USER_AGENTS } from '@/app/robots';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('robots()', () => {
  describe('when DOCS_ALLOW_INDEXING=true (production)', () => {
    it('emits a wildcard Allow rule plus one explicit Allow rule per AI bot', () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const result = robots();

      expect(result.rules).toEqual([
        { userAgent: '*', allow: '/' },
        ...AI_BOT_USER_AGENTS.map(userAgent => ({ userAgent, allow: '/' })),
      ]);
    });

    it('produces 1 wildcard rule + one rule per AI bot in AI_BOT_USER_AGENTS', () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const result = robots();
      const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

      expect(rules).toHaveLength(1 + AI_BOT_USER_AGENTS.length);
    });

    it('declares the canonical sitemap', () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const result = robots();

      expect(result.sitemap).toBe(`${DOCS_SITE_ORIGIN}/sitemap.xml`);
    });

    it('preserves the AI bot list and order required by RFC 9309 guidance', () => {
      expect(AI_BOT_USER_AGENTS).toEqual([
        'GPTBot',
        'OAI-SearchBot',
        'Claude-Web',
        'Google-Extended',
        'Amazonbot',
        'anthropic-ai',
        'Bytespider',
        'CCBot',
        'Applebot-Extended',
      ]);
    });
  });

  describe('when indexing is disabled (preview / PR / local)', () => {
    it('emits a single wildcard Disallow rule and no sitemap', () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', '');

      const result = robots();

      expect(result.rules).toEqual([{ userAgent: '*', disallow: '/' }]);
      expect(result.sitemap).toBeUndefined();
    });

    it('does not emit per-AI-bot blocks', () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'false');

      const result = robots();
      const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

      expect(rules).toHaveLength(1);
      expect(rules[0]).not.toHaveProperty('allow');
    });
  });
});
