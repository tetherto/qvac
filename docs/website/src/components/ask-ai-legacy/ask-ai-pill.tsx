'use client';

import { Sparkles, X } from 'lucide-react';
import { type MouseEvent, useCallback, useState } from 'react';

import { cn } from '@/lib/cn';
import { AskAIShortcutHint, useAskAI } from '@/components/ask-ai';

/**
 * Sticky "Ask AI…" pill anchored to the bottom of the viewport. The
 * whole pill is clickable: a single click opens the assistant modal
 * via `useAskAI().open()`. A trailing `X` lets the user dismiss the
 * bar for the rest of the session (state lives locally so it survives
 * SPA navigations but resets on full reload).
 *
 * This is the simpler "click-to-open" replacement for the original
 * always-on composer bar in `AskAIChatShell` (which had bugs we are
 * not fixing now). The pill is just one of many triggers calling
 * into the same `AskAIProvider`; the actual chat surface comes from
 * `AskAILegacyShell` (Inkeep modal).
 */
export function AskAIPill() {
  const { open, modalState } = useAskAI();
  const isAssistantOpen = modalState !== 'closed';
  const [dismissed, setDismissed] = useState(false);

  const handleOpen = useCallback(() => {
    open();
  }, [open]);

  const handleDismiss = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Stop propagation so the click does not also fall through to
      // the surrounding clickable wrapper and immediately re-open.
      event.stopPropagation();
      setDismissed(true);
    },
    [],
  );

  if (dismissed) return null;

  return (
    <div
      data-ask-ai-pill=""
      // `inert` removes the subtree from focus order AND blocks
      // pointer events while the assistant is open; we still animate
      // opacity / translate for a graceful disappearance.
      inert={isAssistantOpen || undefined}
      className={cn(
        // `z-30` is strictly below the Fumadocs notebook mobile
        // drawer (`z-40`) so opening the hamburger menu does not
        // clip the pill over the menu's bottom icons. The Inkeep
        // modal itself uses internal stacking and renders above
        // both layers.
        'fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-all duration-200 sm:px-6 sm:pb-4',
        isAssistantOpen
          ? 'pointer-events-none translate-y-4 opacity-0'
          : 'translate-y-0 opacity-100',
      )}
    >
      <div className="pointer-events-auto w-full max-w-3xl">
        <div
          role="button"
          tabIndex={0}
          onClick={handleOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleOpen();
            }
          }}
          aria-label="Ask AI anything about QVAC"
          className={cn(
            'flex w-full cursor-pointer items-center gap-3 rounded-full border bg-fd-popover px-4 py-2.5 text-left shadow-lg transition-colors',
            'hover:bg-fd-secondary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
          )}
        >
          <Sparkles
            className="size-4 shrink-0 text-fd-primary"
            aria-hidden="true"
          />
          <span className="flex-1 text-sm text-fd-muted-foreground">
            Ask AI anything about QVAC&hellip;
          </span>
          <AskAIShortcutHint className="shrink-0" />
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss the assistant bar for this session"
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fd-muted-foreground transition-colors',
              'hover:bg-fd-secondary hover:text-fd-popover-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
