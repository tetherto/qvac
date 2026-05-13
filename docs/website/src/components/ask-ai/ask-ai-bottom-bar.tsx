'use client';

import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';
import { AskAIShortcutHint } from './ask-ai-button';

const SAMPLE_QUESTIONS = [
  'How do I get started with QVAC?',
  'How do I run an LLM locally?',
  'How does P2P inference work?',
];

/**
 * Sticky "Ask AI…" bar that hugs the bottom of the viewport on every
 * docs page. Mirrors the entry-point Mintlify ships at the bottom of
 * each docs page: a single search-input-shaped trigger plus a row of
 * suggested questions. Clicking either part funnels through
 * `useAskAI()`, so the same conversation surfaces on whichever surface
 * the viewport is currently using (sidebar on desktop, full-screen
 * modal on mobile).
 *
 * The bar hides itself once the assistant is open, so the user is
 * never staring at two competing prompts at once.
 */
export function AskAIBottomBar() {
  const { open, openWith, sidebarOpen, modalOpen } = useAskAI();
  const isAssistantOpen = sidebarOpen || modalOpen;

  return (
    <div
      data-ask-ai-bottom-bar=""
      aria-hidden={isAssistantOpen ? 'true' : undefined}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-all duration-200 sm:px-6 sm:pb-4',
        isAssistantOpen
          ? 'translate-y-4 opacity-0'
          : 'translate-y-0 opacity-100',
      )}
    >
      <div className="pointer-events-auto flex w-full max-w-3xl flex-col gap-2">
        <button
          type="button"
          onClick={() => open()}
          aria-label="Ask the AI assistant"
          className={cn(
            'group flex w-full items-center gap-3 rounded-full border bg-fd-popover/85 px-4 py-3 text-left shadow-lg backdrop-blur-md transition-colors',
            'hover:bg-fd-accent hover:text-fd-accent-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
          )}
        >
          <Sparkles className="size-4 shrink-0 text-fd-primary" aria-hidden="true" />
          <span className="flex-1 text-sm text-fd-muted-foreground group-hover:text-fd-accent-foreground">
            Ask AI anything about QVAC&hellip;
          </span>
          <AskAIShortcutHint className="shrink-0" />
        </button>
        <div className="hidden flex-wrap items-center gap-2 sm:flex">
          {SAMPLE_QUESTIONS.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => openWith(question)}
              className={cn(
                'rounded-full border bg-fd-popover/70 px-3 py-1 text-xs text-fd-muted-foreground shadow-sm backdrop-blur-md transition-colors',
                'hover:bg-fd-accent hover:text-fd-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
              )}
            >
              {question}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
