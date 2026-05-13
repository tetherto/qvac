'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';

/**
 * Detects the macOS host once on the client. Used to print `⌘` instead
 * of `Ctrl` next to the keyboard hint so the displayed shortcut matches
 * what the user actually presses. Defaults to non-Mac so the SSR markup
 * never renders a Mac-specific glyph.
 */
function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform;
    setIsMac(/mac/i.test(platform));
  }, []);
  return isMac;
}

/**
 * The little `⌘I` / `Ctrl I` chip rendered next to the desktop header
 * trigger. Mirrors the keyboard shortcut surfaced by the
 * `AskAIProvider`.
 */
export function AskAIShortcutHint({ className }: { className?: string }) {
  const isMac = useIsMac();
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none ms-1 hidden items-center gap-0.5 rounded border bg-fd-muted/60 px-1.5 py-px font-mono text-[10px] font-medium text-fd-muted-foreground md:inline-flex',
        className,
      )}
    >
      <span>{isMac ? '⌘' : 'Ctrl'}</span>
      <span>I</span>
    </kbd>
  );
}

export type AskAIButtonVariant = 'header' | 'mobile-header' | 'inline';

interface AskAIButtonProps {
  variant?: AskAIButtonVariant;
  className?: string;
  /** Optional label override; defaults to "Ask AI". */
  label?: string;
  /**
   * Optional `aria-label`. Required when the variant has no visible
   * text (e.g. icon-only buttons).
   */
  ariaLabel?: string;
  /** When true, hides the keyboard shortcut hint on the header variant. */
  hideShortcut?: boolean;
}

const baseClasses =
  'inline-flex items-center gap-2 rounded-md text-sm font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring';

const variantClasses: Record<AskAIButtonVariant, string> = {
  header:
    'h-9 gap-2 border bg-fd-secondary px-3 text-fd-secondary-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
  'mobile-header':
    'h-9 w-9 justify-center rounded-full border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
  inline:
    'h-7 gap-1 rounded-md border bg-fd-secondary px-2 py-1 text-xs text-fd-muted-foreground hover:text-fd-accent-foreground hover:bg-fd-accent',
};

/**
 * Reusable trigger that opens the AI assistant. The same component is
 * used by the desktop header (next to the search input), the mobile
 * top bar (icon-only), and the per-code-block "Ask AI" chip. All
 * variants funnel through `useAskAI().open()` so the conversation state
 * is shared across surfaces.
 */
export function AskAIButton({
  variant = 'header',
  className,
  label = 'Ask AI',
  ariaLabel,
  hideShortcut,
}: AskAIButtonProps) {
  const { open } = useAskAI();
  const showLabel = variant !== 'mobile-header';

  return (
    <button
      type="button"
      data-ask-ai-trigger={variant}
      onClick={() => open()}
      aria-label={ariaLabel ?? (showLabel ? undefined : label)}
      className={cn(baseClasses, variantClasses[variant], className)}
    >
      <Sparkles
        aria-hidden="true"
        className={variant === 'inline' ? 'size-3.5' : 'size-4'}
      />
      {showLabel ? <span>{label}</span> : null}
      {variant === 'header' && !hideShortcut ? <AskAIShortcutHint /> : null}
    </button>
  );
}
