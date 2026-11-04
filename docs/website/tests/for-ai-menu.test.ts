import { describe, expect, it } from 'vitest';

import { AGENT_DOCS_URL } from '../src/lib/agent-docs';
import {
  FOR_AI_ENTRIES,
  MCP_SERVER_URL,
  type ForAiEntry,
} from '../src/lib/for-ai-menu';

/**
 * The shape of the For AI menu.
 *
 * Asserted here rather than against the built site because the menu's entries
 * never reach the built HTML: they live in a popover that renders nothing
 * until a reader opens it. What the build can be held to is the menu's
 * trigger, which `scripts/check-navbar-links.ts` covers. Between the two, the
 * menu is gated end to end — its shape here, its presence there.
 */
describe('the For AI menu', () => {
  const byText = (text: string): ForAiEntry | undefined =>
    FOR_AI_ENTRIES.find((entry) => entry.text === text);

  it('offers the four entry points, in order', () => {
    expect(FOR_AI_ENTRIES.map((entry) => entry.text)).toEqual([
      'Connect the MCP server',
      'Open /llms.txt',
      'Open /llms-full.txt',
      'Use QVAC docs with AI agents',
    ]);
  });

  it('gives the MCP server no URL, because that entry copies rather than navigates', () => {
    // An endpoint followed in a browser yields a stream or an error. Giving
    // this entry a URL would make the framework render it as a link, which is
    // exactly the tab of nothing the copy exists to avoid.
    expect(byText('Connect the MCP server')?.url).toBeUndefined();
  });

  it('names the provider endpoint as the address the reader copies', () => {
    expect(MCP_SERVER_URL).toMatch(/^https:\/\//);
    expect(new URL(MCP_SERVER_URL).protocol).toBe('https:');
  });

  it('offers the site-wide artifacts, not a collection or line copy of them', () => {
    // A menu naming one line's corpus would lengthen with every line cut, and
    // would be guessing at the release the reader means. The root artifacts
    // resolve downward, which is the whole point of the cascade.
    expect(byText('Open /llms.txt')?.url).toBe('/llms.txt');
    expect(byText('Open /llms-full.txt')?.url).toBe('/llms-full.txt');
  });

  it('points at the page through the constant every artifact cites', () => {
    // Not a literal: the same constant reaches all 18 published artifacts, so
    // the menu and the corpora cannot come to name different addresses for
    // one page.
    expect(byText('Use QVAC docs with AI agents')?.url).toBe(AGENT_DOCS_URL);
  });

  it('gives every navigating entry a URL and an icon', () => {
    for (const entry of FOR_AI_ENTRIES) {
      expect(entry.icon).toBeTypeOf('object');
      expect(entry.text.length).toBeGreaterThan(0);
    }
    expect(
      FOR_AI_ENTRIES.filter((entry) => entry.url !== undefined),
    ).toHaveLength(3);
  });
});
