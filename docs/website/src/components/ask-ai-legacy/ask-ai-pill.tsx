'use client';

import { Sparkles, X } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import { AskAIShortcutHint, useAskAI } from '@/components/ask-ai';

// Pixels of slack at the bottom of the document where the pill starts
// fading out. Tuned so the fade triggers right as the user reaches the
// page footer area / prev-next pagination, before the pill can overlap
// meaningful content. Mirrors `PAGE_BOTTOM_FADE_SLACK` in the legacy
// `AskAIChatShell`.
const PAGE_BOTTOM_FADE_SLACK = 96;

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
  const [isPageBottom, setIsPageBottom] = useState(false);

  // Fade the pill out as the user reaches the bottom of the page so it
  // does not overlap the prev/next pagination or footer. Same scroll
  // strategy used by the legacy `AskAIChatShell` composer.
  useEffect(() => {
    function onScroll() {
      if (typeof window === 'undefined') return;
      const atBottom =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - PAGE_BOTTOM_FADE_SLACK;
      setIsPageBottom(atBottom);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

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

  // Hide the pill when the assistant modal is open OR when the user
  // has scrolled to the bottom of the page (where it would overlap
  // the prev/next pagination / footer).
  const isHidden = isAssistantOpen || isPageBottom;

  return (
    <div
      data-ask-ai-pill=""
      // `inert` removes the subtree from focus order AND blocks
      // pointer events while the pill is hidden; we still animate
      // opacity / translate for a graceful disappearance.
      inert={isHidden || undefined}
      // `--ask-ai-scrollbar-gutter` is published by `AskAIProvider`
      // when it locks the page scroll. Reserving the same width on
      // the right of this `position: fixed` wrapper keeps the pill's
      // visual center aligned with the page body (which is already
      // padded by the same amount via `<html>`). Without this, the
      // ICB widens by the scrollbar width when the lock removes the
      // scrollbar, and the centered child appears to shift right.
      style={{ paddingRight: 'var(--ask-ai-scrollbar-gutter, 0px)' }}
      className={cn(
        // `z-30` is strictly below the Fumadocs notebook mobile
        // drawer (`z-40`) so opening the hamburger menu does not
        // clip the pill over the menu's bottom icons. The Inkeep
        // modal itself uses internal stacking and renders above
        // both layers.
        // `transition-[opacity,transform]` instead of `transition-all`
        // so the `paddingRight` gutter compensation (driven by the
        // `--ask-ai-scrollbar-gutter` custom property when the modal
        // opens) applies instantly. With `transition-all`, padding
        // would animate over 200ms in lockstep with the opacity/slide
        // fade-out, which is exactly the horizontal "jump" the user
        // saw - the pill still partially visible while its layout
        // box was sliding right.
        'fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-[opacity,transform] duration-200 sm:px-6 sm:pb-4',
        isHidden
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
            'flex w-full cursor-pointer items-center gap-3 rounded-full border border-fd-border bg-fd-popover px-4 py-2.5 text-left shadow-lg transition-colors',
            'hover:bg-fd-secondary',
            // Theme-colored highlight while the pill is hovered or
            // selected (mouse click or keyboard focus). Mirrors the
            // composer bar from the legacy `AskAIChatShell` so the
            // trigger feels like the input it opens.
            'hover:border-fd-ring hover:ring-1 hover:ring-fd-ring',
            'focus:border-fd-ring focus:outline-none focus:ring-1 focus:ring-fd-ring',
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
