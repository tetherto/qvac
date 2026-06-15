'use client';

import { BookOpen, ExternalLink } from 'lucide-react';

import type { AskAIReference } from './use-ask-ai-chat';

/**
 * Path segments that read as acronyms in the docs nav and should be
 * fully uppercased in a breadcrumb (rather than title-cased to "Ai",
 * "Cli", …). Lowercase keys; matched case-insensitively.
 */
const SECTION_ACRONYMS = new Set([
  'ai',
  'api',
  'cli',
  'kv',
  'llm',
  'ocr',
  'p2p',
  'qvac',
  'rag',
  'sdk',
  'tts',
]);

/**
 * Turn a URL slug segment into a display label: split on hyphens and
 * either uppercase known acronyms or capitalize the first letter.
 * e.g. `ai-capabilities` -> "AI Capabilities", `fine-tuning` -> "Fine Tuning".
 */
function formatSegment(segment: string): string {
  return segment
    .split('-')
    .filter(Boolean)
    .map((word) =>
      SECTION_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * Derive the card's title: prefer the Inkeep-provided title, fall back
 * to the formatted final URL slug (e.g. `video-generation` ->
 * "Video Generation"), and finally the hostname / raw URL.
 */
function referenceTitle(reference: AskAIReference): string {
  const title = reference.title?.trim();
  if (title) return title;
  try {
    const url = new URL(reference.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return formatSegment(last);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return reference.url;
  }
}

/**
 * Display form of a source URL for the card's second line: drop the
 * scheme and a leading `www.`, plus any trailing slash, so it reads as a
 * clean `host/path` (e.g. `docs.qvac.tether.io/ai-capabilities/vla`).
 * Falls back to the raw string if the URL can't be parsed.
 */
function formatDisplayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/$/, '');
    return `${host}${path}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}

/**
 * "Sources" footer shown beneath an assistant answer. Renders the
 * citations Inkeep returned via the `provideLinks` tool as compact,
 * fully-clickable cards (icon + title + URL) so readers can jump to the
 * underlying docs — mirroring the legacy Inkeep widget's source cards.
 * Renders nothing when there are no references (e.g. while streaming, or
 * for answers with no sources).
 */
export function AskAIReferences({ references }: { references: AskAIReference[] }) {
  if (references.length === 0) return null;
  return (
    <div className="mt-3 border-t border-fd-border/60 pt-2.5">
      <p className="mb-1.5 text-xs font-medium text-fd-muted-foreground">Sources</p>
      <ul className="flex flex-col gap-1.5">
        {references.map((reference) => (
          <li key={reference.url}>
            <a
              href={reference.url}
              target="_blank"
              rel="noreferrer noopener"
              className="group flex items-center gap-2.5 rounded-lg border border-fd-border bg-fd-card px-2.5 py-2 transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {/* Open-book badge — a neutral "documentation source" glyph.
                  The inline citations were removed from the answer text, so
                  there's no longer a number to map back to; the icon just
                  marks each card as a docs reference. */}
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-popover text-fd-muted-foreground transition-colors group-hover:border-fd-primary/40 group-hover:text-fd-primary">
                <BookOpen className="size-3.5" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-xs font-medium text-fd-popover-foreground">
                  {referenceTitle(reference)}
                </span>
                <span className="truncate text-[0.7rem] leading-snug text-fd-muted-foreground">
                  {formatDisplayUrl(reference.url)}
                </span>
              </span>
              <ExternalLink
                className="ml-auto size-3 shrink-0 text-fd-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
