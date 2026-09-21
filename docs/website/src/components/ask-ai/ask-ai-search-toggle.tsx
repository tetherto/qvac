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

type SearchToggleSlotProps = {
  className?: string;
  /** Passed by the layout; the inner triggers already handle it. */
  hideIfDisabled?: boolean;
};

/**
 * Fills the Fumadocs `slots.searchTrigger.full` slot. Renders the
 * Search pill alongside a compact "Ask AI" button inside a `w-full`
 * flex row so they share the notebook top-nav slot: the Search pill
 * takes the remaining space (via `flex-1`) and shrinks just enough to
 * make room for the Ask AI button on its right. The button uses the
 * default `header` variant weight (`font-medium` from the shared base
 * classes).
 *
 * Applying the layout's `className` is required, not cosmetic: it
 * carries the `max-w-*` cap for the slot. Without it this `w-full` row
 * consumes the whole header and collapses the nav title's `flex-1`
 * container (basis 0) to zero width, hiding the logo.
 *
 * `ps-0` is re-applied last on purpose. Fumadocs renders the slot as the
 * search *button* itself, so the `ps-2.5` it puts in `className` is meant
 * to override that button's own `ps-2`. Here the slot is a row wrapper,
 * so the same class would instead indent the row and shave ~10px off the
 * Search pill. Dropping it keeps the pill at its `ps-2`.
 */
export function AskAISearchToggleLarge({ className }: SearchToggleSlotProps) {
  return (
    <div className={cn('flex w-full items-center gap-2', className, 'ps-0')}>
      <LargeSearchTrigger />
      <AskAIButton variant="header" className="font-normal" />
    </div>
  );
}

/**
 * Fills the Fumadocs `slots.searchTrigger.sm` slot used on the mobile
 * top bar. Pairs the icon-only search button with an icon-only
 * "Ask AI" button so the user has a tap target for either flow
 * without sacrificing horizontal space.
 */
export function AskAISearchToggleSmall({ className }: SearchToggleSlotProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <SmallSearchTrigger />
      <AskAIButton variant="mobile-header" ariaLabel="Ask the AI assistant" />
    </div>
  );
}
