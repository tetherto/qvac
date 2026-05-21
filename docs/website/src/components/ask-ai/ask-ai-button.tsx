'use client';

import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';

/**
 * The `⌘ I` chip rendered next to the desktop header trigger.
 * Mirrors Fumadocs's Search shortcut layout exactly: a wrapper span
 * with two separate `<kbd>` boxes (one for `⌘`, one for `I`), so the
 * Ask AI shortcut reads as a visual sibling to Search's `⌘ K`. We
 * always render the `⌘` glyph regardless of host OS — Fumadocs does
 * the same for `⌘ K`, treating the symbol as a universal "modifier"
 * sigil rather than a platform-specific instruction. The actual key
 * binding (`Ctrl/Cmd + I`) is wired in `AskAIProvider`.
 */
export function AskAIShortcutHint({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none hidden gap-0.5 md:inline-flex',
        className,
      )}
    >
      <kbd className="rounded-md border bg-fd-background px-1.5 text-[11px] leading-5">
        ⌘
      </kbd>
      <kbd className="rounded-md border bg-fd-background px-1.5 text-[11px] leading-5">
        I
      </kbd>
    </span>
  );
}

export type AskAIButtonVariant =
  | 'header'
  | 'header-icon'
  | 'sidebar-full'
  | 'mobile-header'
  | 'inline';

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
  'inline-flex items-center gap-2 rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring';

const variantClasses: Record<AskAIButtonVariant, string> = {
  header:
    'h-9 gap-2 border bg-fd-secondary/50 px-3 text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
  // Compact icon-only header trigger. Useful in surfaces too narrow
  // for a labelled pill - matches Search's h-9 / rounded-lg / border
  // so the two read as siblings, with a subtle primary-tinted
  // surface and hover lift so the Sparkles icon registers as the
  // "AI" affordance without needing a label.
  'header-icon':
    'size-9 shrink-0 justify-center rounded-lg border border-fd-primary/30 bg-gradient-to-br from-fd-primary/15 via-fd-primary/10 to-transparent text-fd-primary shadow-sm hover:border-fd-primary/50 hover:from-fd-primary/25 hover:via-fd-primary/15 hover:to-fd-primary/5 hover:shadow-md hover:shadow-fd-primary/10',
  // Full-width labelled pill for the sidebar. Stacks beneath the
  // Search pill so both controls get the entire sidebar column
  // width - no cramping, no two-line wrap of "Ask AI". Same h-9 /
  // border / rounded-lg silhouette as Search; primary-tinted
  // gradient surface so the AI control stays visually distinct from
  // (and slightly louder than) Search.
  'sidebar-full':
    'h-9 w-full justify-center gap-2 rounded-lg border border-fd-primary/30 bg-gradient-to-br from-fd-primary/15 via-fd-primary/10 to-transparent px-3 text-fd-primary shadow-sm hover:border-fd-primary/50 hover:from-fd-primary/25 hover:via-fd-primary/15 hover:to-fd-primary/5 hover:shadow-md hover:shadow-fd-primary/10',
  'mobile-header':
    'h-9 w-9 justify-center rounded-full border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent hover:text-fd-accent-foreground',
  inline:
    'h-7 gap-1 rounded-md border bg-fd-secondary px-2 py-1 text-xs text-fd-muted-foreground hover:text-fd-accent-foreground hover:bg-fd-accent',
};

/** Variants that render no visible text and therefore need an
 *  `aria-label` / `title` for accessibility and hover affordance. */
const iconOnlyVariants = new Set<AskAIButtonVariant>([
  'mobile-header',
  'header-icon',
]);

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
  const isIconOnly = iconOnlyVariants.has(variant);
  const showLabel = !isIconOnly;
  const accessibleLabel = ariaLabel ?? (isIconOnly ? label : undefined);

  return (
    <button
      type="button"
      data-ask-ai-trigger={variant}
      onClick={() => open()}
      aria-label={accessibleLabel}
      // `title` surfaces the same label as a native browser tooltip
      // on hover so icon-only triggers stay discoverable without a
      // bespoke tooltip layer.
      title={isIconOnly ? label : undefined}
      className={cn(baseClasses, variantClasses[variant], className)}
    >
      <Sparkles
        aria-hidden="true"
        className={variant === 'inline' ? 'size-3.5' : 'size-4'}
      />
      {showLabel ? <span>{label}</span> : null}
      {(variant === 'header' || variant === 'sidebar-full') && !hideShortcut ? (
        <AskAIShortcutHint className={variant === 'sidebar-full' ? 'ms-auto' : undefined} />
      ) : null}
    </button>
  );
}
