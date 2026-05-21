'use client';

import { Search } from 'lucide-react';
import { useSearchContext } from 'fumadocs-ui/contexts/search';

import { cn } from '@/lib/cn';
import { AskAIButton } from './ask-ai-button';

/**
 * Minimal recreation of Fumadocs's `LargeSearchToggle`.
 *
 * Fumadocs ships its `LargeSearchToggle` / `SearchToggle` components
 * inside `dist/layouts/shared/search-toggle.js`, but the package's
 * `exports` map only publishes `./layouts/shared` (the index, which
 * does NOT re-export them). Recreating the trigger here keeps the
 * docs site free of a deep-import workaround while still preserving
 * the `Cmd/Ctrl+K` hotkey wiring exposed by `useSearchContext()`.
 */
function LargeSearchTrigger({ className }: { className?: string }) {
  const { setOpenSearch, enabled, hotKey } = useSearchContext();
  if (!enabled) return null;

  return (
    <button
      type="button"
      data-search-full=""
      onClick={() => setOpenSearch(true)}
      className={cn(
        'inline-flex h-9 flex-1 items-center gap-2 rounded-lg border bg-fd-secondary/50 p-1.5 ps-2 text-sm text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground',
        className,
      )}
    >
      <Search className="size-4" aria-hidden="true" />
      <span>Search</span>
      <span className="ms-auto inline-flex gap-0.5">
        {hotKey.map((k, i) => (
          <kbd
            key={i}
            className="rounded-md border bg-fd-background px-1.5 text-[11px] leading-5"
          >
            {k.display}
          </kbd>
        ))}
      </span>
    </button>
  );
}

function SmallSearchTrigger({ className }: { className?: string }) {
  const { setOpenSearch, enabled } = useSearchContext();
  if (!enabled) return null;

  return (
    <button
      type="button"
      data-search=""
      onClick={() => setOpenSearch(true)}
      aria-label="Open Search"
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground',
        className,
      )}
    >
      <Search className="size-5" aria-hidden="true" />
    </button>
  );
}

/**
 * Drop-in replacement for the Fumadocs `searchToggle.components.lg`
 * slot. Stacks the Search pill and the Ask AI pill vertically so both
 * controls get the full sidebar column width - no cramping, no
 * two-line wrap of "Ask AI". The Ask AI pill carries its label, a
 * `Ctrl I` keyboard hint that mirrors Search's `Ctrl K`, and a
 * primary-tinted surface so it stays visually distinct.
 */
export function AskAISearchToggleLarge() {
  return (
    <div className="flex w-full flex-col gap-2">
      <LargeSearchTrigger />
      <AskAIButton variant="sidebar-full" ariaLabel="Ask the AI assistant" />
    </div>
  );
}

/**
 * Drop-in replacement for the Fumadocs `searchToggle.components.sm`
 * slot used on the mobile top bar. Pairs the icon-only search button
 * with an icon-only "Ask AI" button so the user has a tap target for
 * either flow without sacrificing horizontal space.
 */
export function AskAISearchToggleSmall() {
  return (
    <div className="flex items-center gap-1">
      <SmallSearchTrigger />
      <AskAIButton variant="mobile-header" ariaLabel="Ask the AI assistant" />
    </div>
  );
}
