import { describe, it, expect, afterEach, vi } from 'vitest';
import { GET, AI_BOT_USER_AGENTS } from '@/app/robots.txt/route';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

const CONTENT_SIGNAL_LINE =
  'Content-Signal: ai-train=yes, search=yes, ai-input=yes';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function getBody(): Promise<string> {
  return await GET().text();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle.length) return 0;
  return haystack.split(needle).length - 1;
}

describe('robots.txt route', () => {
  describe('when DOCS_ALLOW_INDEXING=true (production)', () => {
    it('emits Content-Signal once per User-agent block (wildcard + each AI bot)', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const body = await getBody();

      expect(countOccurrences(body, CONTENT_SIGNAL_LINE)).toBe(
        1 + AI_BOT_USER_AGENTS.length,
      );
    });

    it('emits a wildcard block with Content-Signal and Allow: /', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const body = await getBody();

      expect(body).toContain(
        `User-agent: *\n${CONTENT_SIGNAL_LINE}\nAllow: /`,
      );
    });

    it('emits an explicit block for each AI bot in order, each with Content-Signal and Allow: /', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const body = await getBody();

      let lastIndex = body.indexOf('User-agent: *');
      expect(lastIndex).toBeGreaterThanOrEqual(0);

      for (const bot of AI_BOT_USER_AGENTS) {
        const block = `User-agent: ${bot}\n${CONTENT_SIGNAL_LINE}\nAllow: /`;
        const idx = body.indexOf(block);
        expect(idx, `block for ${bot} not found`).toBeGreaterThan(lastIndex);
        lastIndex = idx;
      }
    });

    it('terminates with a Sitemap line pointing at the canonical sitemap', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');

      const body = await getBody();

      expect(body.endsWith(`Sitemap: ${DOCS_SITE_ORIGIN}/sitemap.xml\n`)).toBe(
        true,
      );
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
    it('emits exactly a wildcard Disallow body and nothing else', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', '');

      const body = await getBody();

      expect(body).toBe('User-agent: *\nDisallow: /\n');
    });

    it('does not emit Content-Signal or Sitemap', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', 'false');

      const body = await getBody();

      expect(body).not.toContain('Content-Signal');
      expect(body).not.toContain('Sitemap:');
    });

    it('does not emit per-AI-bot blocks', async () => {
      vi.stubEnv('DOCS_ALLOW_INDEXING', '');

      const body = await getBody();

      for (const bot of AI_BOT_USER_AGENTS) {
        expect(body).not.toContain(`User-agent: ${bot}`);
      }
    });
  });
});
