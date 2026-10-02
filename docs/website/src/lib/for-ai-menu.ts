import { Bot, FileText, Files, Plug, type LucideIcon } from 'lucide-react';
import { AGENT_DOCS_URL } from '@/lib/agent-docs';

/**
 * Where an agent connects to this documentation's knowledge base.
 *
 * A public endpoint of the provider that also backs search and the assistant,
 * so the corpus behind it is the one this site already feeds. Held as a
 * constant because no build check can verify a third party's endpoint without
 * calling it, and a build that called it would fail on their outage.
 */
export const MCP_SERVER_URL = 'https://mcp.inkeep.com/tetherio/mcp';

export interface ForAiEntry {
  text: string;
  icon: LucideIcon;
  /** Absent on the entry that copies an address rather than navigating. */
  url?: string;
  external?: boolean;
}

/**
 * What the For AI menu offers, in order.
 *
 * Declared as data rather than built inline in the layout, because it is the
 * only place the menu's shape can be asserted. The entries live in a popover,
 * which renders nothing until a reader opens it, so none of this reaches the
 * built HTML — a gate reading the built pages can see the menu's trigger and
 * no more. `tests/for-ai-menu.test.ts` holds the shape against this; the
 * navbar check holds the trigger against the build.
 *
 * Only the site-wide artifacts are named. Each is the top of a cascade that
 * resolves downward — the root index routes an agent to a collection's, which
 * routes it to a line's — so one entry point is offered rather than a list
 * that lengthens with every documentation line cut. For the same reason the
 * entries do not follow the reader's position: choosing a line for an agent
 * is the job of the resolver index and of the page the last entry leads to.
 *
 * The first entry carries no `url` because it copies rather than navigates;
 * the layout renders it as the menu's one custom child. See
 * `components/for-ai-menu.tsx`.
 */
export const FOR_AI_ENTRIES: ForAiEntry[] = [
  { text: 'Connect the MCP server', icon: Plug },
  { text: 'Open /llms.txt', url: '/llms.txt', icon: FileText, external: true },
  {
    text: 'Open /llms-full.txt',
    url: '/llms-full.txt',
    icon: Files,
    external: true,
  },
  { text: 'Use QVAC docs with AI agents', url: AGENT_DOCS_URL, icon: Bot },
];

/** What the navbar's menu is labelled, shared with the check that finds it. */
export const FOR_AI_LABEL = 'For AI';
