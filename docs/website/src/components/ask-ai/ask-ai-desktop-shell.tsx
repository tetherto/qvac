'use client';

import dynamic from 'next/dynamic';
import { ArrowUp, Maximize2, Minimize2, Sparkles, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { AIChatFunctions, InkeepBaseSettings } from '@inkeep/cxkit-types';
import type { InkeepEmbeddedChatProps } from '@inkeep/cxkit-react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';
import type { AskAIContextSnippet } from './types';

// `@inkeep/cxkit-react` weighs ~1.35 MB minified. Loading it via
// `next/dynamic` with `ssr: false` keeps it out of the critical-path
// bundle. We use `InkeepEmbeddedChat` (chat-only, no chrome) and wrap
// it in our own bar/modal/expanded states.
const InkeepEmbeddedChat = dynamic(
  () => import('@inkeep/cxkit-react').then((m) => ({ default: m.InkeepEmbeddedChat })),
  { ssr: false, loading: () => null },
);

// Pixels of slack at the bottom of the document where the bar starts
// fading out. Tuned so the fade triggers right as the user reaches
// the page footer area, before the bar can overlap meaningful content.
const PAGE_BOTTOM_FADE_SLACK = 96;

/**
 * Render a queued context snippet into a Markdown block the assistant
 * can pick up as input. Code-block snippets are wrapped in a fenced
 * code block keyed off the captured language so the assistant has the
 * same surrounding context the docs reader is looking at.
 */
function renderContextBlock(context: AskAIContextSnippet): string {
  const header = context.source === 'code-block' ? 'Context (code)' : 'Context';
  const hrefLine = context.href ? `\nFrom: ${context.href}` : '';
  if (context.source === 'code-block') {
    const fenceLang = context.language ?? '';
    return `${header}:${hrefLine}\n\`\`\`${fenceLang}\n${context.text}\n\`\`\`\n\n`;
  }
  return `${header}:${hrefLine}\n> ${context.text.replace(/\n/g, '\n> ')}\n\n`;
}

/**
 * Best-effort flush of a queued prompt / context snippet into the
 * embedded chat. The Inkeep `chatFunctionsRef` is only populated once
 * `InkeepEmbeddedChat` has mounted inside its Shadow DOM, so on the
 * very first open (cold chunk download, Shadow DOM bootstrap) the ref
 * may take a few hundred milliseconds to appear. We poll for ~3 s.
 *
 * We always stage the composed text via `updateInputMessage` first as
 * a visible fallback (so the user sees their text even if submission
 * fails), then call `submitMessage(text)` with the text passed
 * EXPLICITLY — Inkeep's `submitMessage(e = C)` falls back to its
 * internal input state when `e` is undefined, which races with the
 * `updateInputMessage` setter we just queued.
 */
function flushPending(
  ref: React.RefObject<AIChatFunctions | null>,
  prompt: string | null,
  context: AskAIContextSnippet | null,
) {
  if (!prompt && !context) return;

  let attempts = 0;
  const MAX_ATTEMPTS = 180; // ~3 s at 60 fps

  function tick() {
    const fns = ref.current;
    if (!fns) {
      if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tick);
      return;
    }

    const contextBlock = context ? renderContextBlock(context) : '';
    const composed = `${contextBlock}${prompt ?? ''}`;

    fns.updateInputMessage(composed);
    fns.focusInput();
    if (!prompt) return;
    fns.submitMessage(composed);
  }

  requestAnimationFrame(tick);
}

interface AskAIDesktopShellProps {
  baseSettings: InkeepBaseSettings;
  aiChatSettings: NonNullable<InkeepEmbeddedChatProps['aiChatSettings']>;
}

/**
 * Desktop chat surface. One persistent container at the bottom of the
 * viewport that morphs through three visual states driven by
 * `useAskAI().desktopState`:
 *
 *  - `closed`   - only the bar input is visible (the InkeepEmbeddedChat
 *                 modal is rendered but `opacity-0 pointer-events-none`).
 *                 Submitting the bar input triggers `openWith()` which
 *                 transitions to `open` and auto-submits via the flush
 *                 effect.
 *  - `open`     - bar fades out; modal fades in centered on the docs
 *                 page column (width matches `--fd-page-width`), with
 *                 the InkeepEmbeddedChat showing the conversation
 *                 above the modal's own input. Modal sits flush with
 *                 the bottom of the viewport so the visual input
 *                 position barely moves.
 *  - `expanded` - same modal, expanded to fill the viewport with a
 *                 small margin.
 *
 * The `InkeepEmbeddedChat` instance stays mounted across state
 * transitions so the conversation history persists when the user
 * collapses to the bar and re-opens.
 *
 * Mobile is handled by `MobileModal` in `ask-ai-shell.tsx`.
 */
export function AskAIDesktopShell({
  baseSettings,
  aiChatSettings,
}: AskAIDesktopShellProps) {
  const askAI = useAskAI();
  const chatFunctionsRef = useRef<AIChatFunctions | null>(null);
  const [barValue, setBarValue] = useState('');
  const [isPageBottom, setIsPageBottom] = useState(false);

  const isModalOpen = askAI.desktopState !== 'closed';
  const isExpanded = askAI.desktopState === 'expanded';

  // -------------------------------------------------------------------
  // Bar fade-out when the user scrolls to the bottom of the page, so
  // it doesn't overlap the footer / closing CTA. Passive scroll +
  // resize listeners; bar fades back in once the user scrolls up.
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // Drain queued prompt / context whenever the modal opens OR when a
  // new pending payload arrives while it's already open. Reads off the
  // render-captured context directly (NOT via a setState-updater
  // closure trick — React 19 concurrent mode runs those on the next
  // render pass, not synchronously).
  // -------------------------------------------------------------------
  useEffect(() => {
    if (askAI.desktopState === 'closed') return;
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;
    flushPending(chatFunctionsRef, prompt, context);
    askAI.clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.desktopState, askAI.pendingPrompt, askAI.pendingContext]);

  // -------------------------------------------------------------------
  // Esc key closes the modal (does NOT touch the expand state).
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!isModalOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        askAI.closeModal();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isModalOpen, askAI]);

  // -------------------------------------------------------------------
  // Bar submit: trim, queue, open the modal. Empty submit just opens
  // the modal so the user can type/continue inside.
  // -------------------------------------------------------------------
  const handleBarSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = barValue.trim();
      if (!trimmed) {
        askAI.openModal();
        return;
      }
      askAI.openWith(trimmed);
      setBarValue('');
    },
    [askAI, barValue],
  );

  const barHidden = isModalOpen || isPageBottom;

  return (
    <>
      {/* Backdrop. Blocks page interaction whenever the modal is open,
          matches the requested "modal that overlays and blocks the use
          of the site" behavior. Click-through closes the modal. */}
      <div
        data-ask-ai-backdrop=""
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-30 bg-fd-background/50 backdrop-blur-sm transition-opacity duration-200',
          isModalOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={askAI.closeModal}
      />

      {/* Bar (closed state). Hidden via opacity + pointer-events when
          the modal is open or the user has scrolled to the page
          bottom. Same width as `--fd-page-width` so it never crosses
          the article column boundary. */}
      <div
        data-ask-ai-bar=""
        // `inert` removes the subtree from focus order AND blocks
        // pointer events while the bar is hidden, so we never have a
        // focused element inside a visually-invisible subtree.
        inert={barHidden || undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 sm:px-6 sm:pb-4',
          'transition-[opacity,transform] duration-200',
          barHidden
            ? 'pointer-events-none translate-y-4 opacity-0'
            : 'translate-y-0 opacity-100',
        )}
      >
        <form
          onSubmit={handleBarSubmit}
          role="search"
          className={cn(
            'flex w-full items-center gap-3 rounded-full border bg-fd-popover px-4 py-2.5 shadow-lg',
            'focus-within:ring-2 focus-within:ring-fd-ring',
          )}
          style={{ maxWidth: 'var(--fd-page-width, 900px)' }}
        >
          <Sparkles
            className="size-4 shrink-0 text-fd-primary"
            aria-hidden="true"
          />
          <input
            type="text"
            value={barValue}
            onChange={(event) => setBarValue(event.target.value)}
            placeholder="Ask AI a question…"
            aria-label="Ask the AI assistant"
            className="flex-1 bg-transparent text-sm text-fd-popover-foreground placeholder:text-fd-muted-foreground focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Open the AI assistant"
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground transition-opacity',
              'hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
            )}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </form>
      </div>

      {/* Modal (open / expanded states). ALWAYS mounted so the
          InkeepEmbeddedChat instance — and therefore the conversation
          history — persists when the user collapses to the bar and
          re-opens. Visibility is driven by opacity + pointer-events +
          inert. Width and height transition between body-width and
          fullscreen-with-margin. */}
      <div
        data-ask-ai-modal=""
        data-desktop-state={askAI.desktopState}
        inert={!isModalOpen || undefined}
        className={cn(
          'fixed z-40 flex flex-col overflow-hidden rounded-2xl border bg-fd-popover text-fd-popover-foreground shadow-2xl',
          'transition-[opacity,inset,width,height,transform] duration-200',
          // Open / expanded geometry
          isExpanded
            ? 'inset-4 w-auto h-auto translate-x-0'
            : 'bottom-3 left-1/2 -translate-x-1/2 h-[70vh] max-h-[80vh] sm:bottom-4',
          // Visibility
          isModalOpen
            ? 'pointer-events-auto opacity-100 scale-100'
            : 'pointer-events-none scale-[0.98] opacity-0',
        )}
        // Width follows the docs body column so the modal sits exactly
        // over the article content (only in the body-width state; the
        // `inset-4` rule above takes over in expanded mode).
        style={
          isExpanded
            ? undefined
            : { width: 'min(100% - 1.5rem, var(--fd-page-width, 900px))' }
        }
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-fd-border bg-fd-popover px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4 text-fd-primary" aria-hidden="true" />
            <span>Ask AI</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={askAI.toggleExpand}
              aria-label={isExpanded ? 'Collapse to body width' : 'Expand to fullscreen'}
              title={isExpanded ? 'Collapse' : 'Expand'}
              className="inline-flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {isExpanded ? (
                <Minimize2 className="size-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={askAI.closeModal}
              aria-label="Close the AI assistant"
              title="Close (Esc)"
              className="inline-flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Chat body. The `min-h-0` is required for the inner Inkeep
            chat to compute its own scroll height correctly inside a
            flex column. `variant="no-shadow"` strips Inkeep's outer
            wrapper styling since we're providing our own modal chrome. */}
        <div className="flex-1 min-h-0">
          <InkeepEmbeddedChat
            baseSettings={baseSettings}
            aiChatSettings={{ ...aiChatSettings, chatFunctionsRef }}
            variant="no-shadow"
          />
        </div>
      </div>
    </>
  );
}
