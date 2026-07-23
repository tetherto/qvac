'use client';

import { Sparkles } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import { AskAIChatMessage } from './ask-ai-chat-message';
import type { ChatMessage } from './use-ask-ai-chat';

interface AskAIChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

/**
 * Scrollable message rail. Owns its own overflow so the page behind
 * the modal never scrolls (Dima's bug fix). Auto-snaps to the bottom
 * on new content - but only if the user was already near the bottom,
 * so a user reading earlier history isn't yanked away by a fresh
 * streaming chunk.
 *
 * Empty state shows a centered Ask-AI prompt so first-time users
 * understand they can type into the input below.
 */
export function AskAIChatMessages({ messages, isStreaming }: AskAIChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is "pinned" to the bottom of the list. We
  // update this on every scroll; auto-scroll only fires when true.
  const isPinnedRef = useRef(true);

  // Re-pin on scroll-to-bottom; un-pin on scroll-up. The 32 px slop
  // covers font-rounding so the auto-scroll keeps firing while the
  // assistant streams its reply.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    function onScroll() {
      if (!node) return;
      const distanceFromBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight;
      isPinnedRef.current = distanceFromBottom < 32;
    }
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // useLayoutEffect (not useEffect) so the scroll happens before the
  // browser paints - the user never sees the list mid-jump.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (!isPinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages]);

  const isEmpty = messages.length === 0;

  return (
    <div
      ref={containerRef}
      data-ask-ai-messages=""
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        // The scrollbar lives INSIDE this container per the review
        // ("scroll would be on the right side of the chatbox") so we
        // do not propagate scroll up to the page.
      )}
    >
      {isEmpty ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col divide-y divide-fd-border/60">
          {messages.map((message, index) => {
            // The assistant placeholder is appended (empty) the moment
            // the user submits, so it's the last message until the
            // first token streams in. While it's still empty we render
            // the cycling "waiting" indicator in its place instead of a
            // blank bubble.
            const isWaiting =
              isStreaming &&
              index === messages.length - 1 &&
              message.role === 'assistant' &&
              message.content.length === 0;
            return (
              <AskAIChatMessage
                key={message.id}
                message={message}
                isWaiting={isWaiting}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-fd-muted-foreground">
      <Sparkles className="size-6 text-fd-primary" aria-hidden="true" />
      <p>Ask anything about QVAC.</p>
    </div>
  );
}
