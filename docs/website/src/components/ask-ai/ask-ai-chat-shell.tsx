'use client';

import { ArrowUp, Maximize2, Minimize2, Sparkles, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { cn } from '@/lib/cn';
import { AskAIChatMessages } from './ask-ai-chat-messages';
import { useAskAI } from './ask-ai-provider';
import type { AskAIContextSnippet } from './types';
import { useAskAIChat } from './use-ask-ai-chat';

// Pixels of slack at the bottom of the document where the bar starts
// fading out. Tuned so the fade triggers right as the user reaches
// the page footer area, before the bar can overlap meaningful
// content.
const PAGE_BOTTOM_FADE_SLACK = 96;

/**
 * Render a queued context snippet into a Markdown block the
 * assistant can pick up as input. Code-block snippets are wrapped in
 * a fenced code block keyed off the captured language so the
 * assistant has the same surrounding context the docs reader is
 * looking at.
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
 * Unified chat shell. ONE persistent fixed container at the bottom
 * of the viewport, identical on desktop and mobile (the container
 * itself is responsive). Three visual states drive the geometry but
 * the DOM is the same:
 *
 *  - `closed`   - only the input row is visible (acts as the bar).
 *  - `open`     - header + messages + input, body-width on desktop,
 *                 near-full-screen on mobile. Backdrop blocks page
 *                 interaction; page scroll is locked.
 *  - `expanded` - same DOM, container fills the viewport (desktop
 *                 only - mobile already maxes out).
 *
 * The input row is the LAST child in every state, so its visual
 * position is stable across transitions: only the header and message
 * list above it expand/collapse. This is the "input stays in same
 * place" guarantee from the review.
 *
 * The chat hook lives in this component, so the conversation
 * persists across `closed <-> open <-> expanded` without any extra
 * plumbing - the shell itself never unmounts.
 */
export function AskAIChatShell() {
  const askAI = useAskAI();
  const apiKey = process.env.NEXT_PUBLIC_INKEEP_API_KEY;
  const chat = useAskAIChat({ apiKey });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isPageBottom, setIsPageBottom] = useState(false);

  const isModalOpen = askAI.modalState !== 'closed';
  const isExpanded = askAI.modalState === 'expanded';

  // -------------------------------------------------------------
  // Bar fade-out when the user scrolls to the bottom of the page,
  // so it does not overlap the footer / closing CTA.
  // -------------------------------------------------------------
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

  // -------------------------------------------------------------
  // Drain queued prompt / context whenever the modal is open OR a
  // new pending payload arrives while it's already open. We read
  // off the render-captured context directly (NOT via a setState-
  // updater closure trick - React 19 concurrent mode runs those on
  // the next render pass, not synchronously, which previously
  // dropped the prompt).
  //
  // The flush calls `chat.send(text)` directly - no waiting for an
  // Inkeep ref to populate, no timing race. Our hook IS the chat.
  // -------------------------------------------------------------
  useEffect(() => {
    if (askAI.modalState === 'closed') return;
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;

    const contextBlock = context ? renderContextBlock(context) : '';
    const composed = `${contextBlock}${prompt ?? ''}`.trim();

    if (prompt) {
      // Auto-submit (the typical bottom-bar Enter / open-with flow).
      void chat.send(composed);
    } else if (context) {
      // Context-only (text selection / code block "Ask AI") - stage
      // the snippet in the input so the user can finish their
      // question, then send themselves.
      chat.setInput(composed);
      inputRef.current?.focus();
    }

    askAI.clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.modalState, askAI.pendingPrompt, askAI.pendingContext]);

  // -------------------------------------------------------------
  // Focus the input whenever the modal opens (from any trigger) so
  // the user can type immediately. `preventScroll: true` is critical:
  // without it the browser may scroll the document to bring the
  // focused input into view, which - combined with the page-scroll
  // lock - manifests as a one-frame visual jump of the input field
  // mid-open animation.
  // -------------------------------------------------------------
  useEffect(() => {
    if (askAI.modalState === 'closed') return;
    // requestAnimationFrame so the transition has started and the
    // input is interactable.
    const id = requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(id);
  }, [askAI.modalState]);

  // -------------------------------------------------------------
  // Esc closes the modal (does NOT touch the expand state).
  // -------------------------------------------------------------
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

  // -------------------------------------------------------------
  // Form submit: if closed, opens the modal in the same beat (so
  // the user sees their message immediately rendered above the
  // input). If already open, just sends.
  // -------------------------------------------------------------
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = chat.input.trim();
      if (!trimmed) return;
      if (askAI.modalState === 'closed') askAI.openModal();
      void chat.send(trimmed);
    },
    [askAI, chat],
  );

  // The bar is hidden when the modal is open OR when the user has
  // scrolled to the page bottom. We don't unmount the container in
  // either case - the input must remain in the DOM so React can
  // preserve its focus across the transition.
  const barChromeHidden = isModalOpen || isPageBottom;

  return (
    <>
      {/* Backdrop. Blocks page interaction whenever the modal is
          open. Clicking it closes the modal. A very light blur +
          subtle fill is enough to telegraph "modal is active"
          without smearing the underlying page content. */}
      <div
        data-ask-ai-backdrop=""
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-40 bg-fd-background/35 backdrop-blur-[1.5px] transition-opacity duration-300',
          isModalOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={askAI.closeModal}
      />

      {/* The shell container. Same DOM node across all three states;
          only the geometry / chrome visibility changes. Input is the
          LAST child so its vertical position never shifts.
          IMPORTANT: closed state uses a DEFINITE height (`h-14`,
          matching the form row) - NOT `h-auto`. CSS cannot
          interpolate between `auto` and a fixed length, so an
          `auto -> fixed` transition would make the shell snap to
          full size and only the inner header would animate, giving
          a top-down "content appearing" feel. With both ends
          definite the shell smoothly grows from `h-14` upward
          (bottom-anchored at `bottom-3`), so the panel reads as
          rolling up from the bottom edge. */}
      <div
        data-ask-ai-shell=""
        data-modal-state={askAI.modalState}
        // `inert` while the bar would be hidden (page-bottom fade,
        // not modal-open - modal-open is a special case because the
        // input is still inside the modal). Prevents the bar from
        // grabbing focus while invisible.
        inert={!isModalOpen && barChromeHidden ? true : undefined}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden rounded-2xl border bg-fd-popover text-fd-popover-foreground shadow-2xl',
          'transition-[height,inset,opacity,transform] duration-300 ease-out',
          // Geometry per state. Width is the same in `closed` and
          // `open` (the bar and modal align edge-to-edge - that's
          // the "bottom bar same width as modal" rule). `expanded`
          // overrides everything to fill the viewport with margin.
          isExpanded
            ? 'inset-4 h-auto w-auto translate-x-0'
            : cn(
                'left-1/2 -translate-x-1/2',
                'bottom-3 sm:bottom-4',
                'w-[calc(100%-1rem)] sm:w-[min(100%-1.5rem,var(--fd-page-width,900px))]',
                askAI.modalState === 'open'
                  ? 'h-[min(85vh,720px)] max-md:h-[calc(100vh-1rem)] max-md:inset-x-2 max-md:bottom-2 max-md:top-2 max-md:w-auto'
                  : 'h-14',
              ),
          // Fade-out for page bottom (closed state only). The modal
          // open path always has full opacity.
          !isModalOpen && isPageBottom
            ? 'pointer-events-none translate-y-4 opacity-0'
            : '',
        )}
      >
        {/* Header. Visible only when the modal is open or expanded.
            Collapses to `h-0` when closed so the shell's `h-14`
            geometry can fit the form alone (the form is anchored
            with `mt-auto` below; the messages wrapper - always
            `flex-1` - absorbs whatever space is left between the
            header and the form). Both the header height and the
            shell height animate over the same 300ms so the upward
            roll-out reads as one motion, while the form's viewport
            position stays invariant the whole time. */}
        <header
          className={cn(
            'flex flex-none items-center justify-between border-b border-fd-border bg-fd-popover px-3 py-2 transition-[height,opacity,padding] duration-300',
            isModalOpen
              ? 'h-10 opacity-100'
              : 'pointer-events-none h-0 overflow-hidden border-b-0 p-0 opacity-0',
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4 text-fd-primary" aria-hidden="true" />
            <span>Ask AI</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={chat.clear}
              disabled={chat.messages.length === 0 && !chat.isStreaming}
              aria-label="Start a new conversation"
              title="Start a new conversation"
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              New chat
            </button>
            <button
              type="button"
              onClick={askAI.toggleExpand}
              aria-label={isExpanded ? 'Collapse to body width' : 'Expand to fullscreen'}
              title={isExpanded ? 'Collapse' : 'Expand'}
              // Hidden on mobile because the modal is already
              // near-fullscreen there - expanding would do nothing
              // visible.
              className="hidden sm:inline-flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
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

        {/* Messages list. Owns its own scroll so the page behind the
            modal never moves. Always `flex-1` so it greedily takes
            every pixel of vertical space the shell has left after
            the header (above) and the form (below, `mt-auto`).
            Only `opacity` is animated - the actual size change is
            implicit: the shell's `h-14 -> h-[720]` height transition
            grows the available space, and `flex-1` follows.
            Toggling `flex-none -> flex-1` (the previous approach)
            caused a one-frame layout reflow that visibly nudged the
            form mid-animation. NOTE: This wrapper MUST be
            `flex flex-col` so the inner `AskAIChatMessages`
            `flex-1 overflow-y-auto` picks up a definite height. */}
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col transition-opacity duration-300',
            isModalOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <AskAIChatMessages messages={chat.messages} isStreaming={chat.isStreaming} />
        </div>

        {/* Input row. ALWAYS the last child of the container, in
            every state. `mt-auto` + `flex-none` pin it to the
            shell's bottom edge so its viewport position is
            invariant across all three states - the shell may grow
            or shrink upward, but the form never moves. The field
            itself is wrapped in a pill so it reads as a proper
            text input rather than naked text on the popover
            surface. */}
        <form
          onSubmit={handleSubmit}
          role="search"
          className={cn(
            'mt-auto flex flex-none items-center gap-2 px-3 py-2.5',
            // When modal is open we add a top border so the input
            // visually separates from the messages above. When
            // closed there's nothing above, so no border.
            isModalOpen ? 'border-t border-fd-border' : '',
          )}
        >
          <div
            className={cn(
              'flex flex-1 items-center gap-2 rounded-full border border-fd-border bg-fd-background px-3 py-1.5',
              'transition-colors focus-within:border-fd-ring focus-within:ring-1 focus-within:ring-fd-ring',
            )}
          >
            <Sparkles
              className="size-4 shrink-0 text-fd-primary"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              value={chat.input}
              onChange={(event) => chat.setInput(event.target.value)}
              placeholder={isModalOpen ? 'Ask a follow-up…' : 'Ask AI a question…'}
              aria-label="Ask the AI assistant"
              className="min-w-0 flex-1 bg-transparent text-sm text-fd-popover-foreground placeholder:text-fd-muted-foreground focus:outline-none"
              disabled={chat.isStreaming}
            />
          </div>
          {chat.isStreaming ? (
            <button
              type="button"
              onClick={chat.stop}
              aria-label="Stop generating"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-fd-border bg-fd-secondary text-fd-secondary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <span aria-hidden="true" className="size-2.5 rounded-sm bg-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={chat.input.trim().length === 0}
              aria-label="Send"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          )}
        </form>

        {/* Error banner (rendered only when present). Sits ABOVE the
            input so it's visible even when closed. */}
        {chat.error ? (
          <div
            role="alert"
            className="border-t border-fd-border bg-fd-card px-3 py-2 text-xs text-fd-muted-foreground"
          >
            {chat.error.message}
          </div>
        ) : null}
      </div>
    </>
  );
}
