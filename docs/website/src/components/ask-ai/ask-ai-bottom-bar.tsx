'use client';

import { ArrowUp, Sparkles, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';
import { AskAIShortcutHint } from './ask-ai-button';

type BarMode = 'idle' | 'compose';

/**
 * Sticky "Ask AI…" bar that hugs the bottom of the viewport on every
 * docs page. Two distinct surfaces collapsed into one component:
 *
 * - **Idle**: a pill that looks like a search trigger — sparkles +
 *   "Ask AI anything about QVAC…" + the `Cmd/Ctrl+I` shortcut hint.
 *   Clicking the body switches to compose mode in place. A trailing
 *   `X` lets the user dismiss the bar for the rest of the session
 *   (state lives locally so it survives all in-app navigation but
 *   resets on reload — the docs layout doesn't unmount during App
 *   Router transitions).
 * - **Compose**: same pill silhouette, but the label is replaced with
 *   a real `<input>` plus a send button. Submit (Enter or arrow click)
 *   forwards the typed query to `useAskAI().openWith(value)`, which
 *   already opens the active surface and auto-submits the message.
 *   Esc / blur with an empty field returns to idle.
 *
 * The bar fades out with `inert` while the assistant is open so we
 * don't show two competing prompts at once.
 */
export function AskAIBottomBar() {
  const { open, openWith, sidebarOpen, modalOpen } = useAskAI();
  const isAssistantOpen = sidebarOpen || modalOpen;

  // Session-scoped dismissal: this bar lives in `(docs)/layout.tsx`,
  // which the App Router keeps mounted across docs page navigations.
  // Local state therefore persists until a full reload — which is the
  // exact UX the review asked for.
  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState<BarMode>('idle');
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the field whenever we transition into compose mode so
  // the user gets a blinking cursor immediately, no second click
  // required.
  useEffect(() => {
    if (mode !== 'compose') return;
    inputRef.current?.focus();
  }, [mode]);

  const enterCompose = useCallback(() => {
    setMode('compose');
  }, []);

  const exitCompose = useCallback(() => {
    setMode('idle');
    setValue('');
  }, []);

  const handleSubmit = useCallback(
    (event?: FormEvent | MouseEvent) => {
      event?.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) {
        // Empty submit just bounces back to idle — same as Esc.
        exitCompose();
        return;
      }
      openWith(trimmed);
      exitCompose();
    },
    [value, openWith, exitCompose],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exitCompose();
      }
    },
    [exitCompose],
  );

  const handleBlur = useCallback(() => {
    // Only auto-collapse when there's nothing in the field — otherwise
    // the user might be reaching for the send button and we'd lose the
    // text mid-click.
    if (value.trim().length === 0) exitCompose();
  }, [value, exitCompose]);

  const handleDismiss = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Stop the event before it bubbles into the surrounding click
      // handler that switches into compose mode.
      event.stopPropagation();
      setDismissed(true);
    },
    [],
  );

  const handleIdleClick = useCallback(() => {
    // The whole pill is the trigger for compose, but if the assistant
    // is opening (e.g. via hotkey) we let the existing open() path win
    // so the user lands directly in the sidebar.
    if (isAssistantOpen) {
      open();
      return;
    }
    enterCompose();
  }, [isAssistantOpen, open, enterCompose]);

  if (dismissed) return null;

  const pillClasses = cn(
    'flex w-full items-center gap-3 rounded-full border bg-fd-popover px-4 py-2.5 text-left shadow-lg transition-colors',
    'focus-within:ring-2 focus-within:ring-fd-ring',
  );

  return (
    <div
      data-ask-ai-bottom-bar=""
      data-ask-ai-mode={mode}
      // `inert` removes the subtree from focus order AND blocks pointer
      // events when the assistant is already open; we still animate
      // opacity / translate for a graceful disappearance.
      inert={isAssistantOpen || undefined}
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-all duration-200 sm:px-6 sm:pb-4',
        isAssistantOpen
          ? 'pointer-events-none translate-y-4 opacity-0'
          : 'translate-y-0 opacity-100',
      )}
    >
      <div className="w-full max-w-3xl">
        {mode === 'compose' ? (
          <form
            role="search"
            onSubmit={handleSubmit}
            className={pillClasses}
          >
            <Sparkles
              className="size-4 shrink-0 text-fd-primary"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              // JSX attribute values are raw text, NOT JS string literals,
              // so `"\u2026"` would render the four literal characters
              // instead of the … ellipsis glyph. We use the actual
              // Unicode ellipsis character directly here. (If you need
              // an escape sequence in an attribute value, wrap it in
              // braces: `placeholder={"Ask a question\u2026"}`.)
              placeholder="Ask a question…"
              aria-label="Ask the AI assistant a question"
              className="flex-1 bg-transparent text-sm text-fd-popover-foreground placeholder:text-fd-muted-foreground focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Send to the AI assistant"
              disabled={value.trim().length === 0}
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-fd-primary text-fd-primary-foreground transition-opacity',
                'disabled:cursor-not-allowed disabled:opacity-40',
                'hover:opacity-90',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
              )}
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
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
          </form>
        ) : (
          <div
            // The whole pill is clickable. Using a `<div role="button">`
            // wrapper rather than nesting a `<button>` lets us host the
            // dismiss `<button>` inside without the HTML "no buttons in
            // buttons" rule. We hand-roll keyboard activation below.
            role="button"
            tabIndex={0}
            onClick={handleIdleClick}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleIdleClick();
              }
            }}
            aria-label="Ask AI anything about QVAC"
            className={cn(
              pillClasses,
              'cursor-text hover:bg-fd-secondary',
              'focus-visible:outline-none',
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
                'hover:bg-fd-popover hover:text-fd-popover-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
              )}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
