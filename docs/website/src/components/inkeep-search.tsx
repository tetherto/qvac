'use client';

import type { SharedProps } from 'fumadocs-ui/components/dialog/search';
import {
  InkeepModalSearchAndChat,
  type InkeepModalSearchAndChatProps,
} from '@inkeep/cxkit-react';
import { useEffect, useState } from 'react';

import { useAskAI } from '@/components/ask-ai';

/**
 * Fumadocs's `RootProvider` mounts this as the `Cmd/Ctrl+K` search
 * dialog. It stays a search-first modal on every breakpoint; the
 * in-modal "Ask AI" tab is hijacked and forwarded to our own chat
 * shell so the docs site has exactly one chat conversation surface.
 */
export default function CustomDialog(props: SharedProps) {
  const askAI = useAskAI();
  const [syncTarget, setSyncTarget] = useState<HTMLElement | null>(null);
  const { open, onOpenChange } = props;

  useEffect(() => {
    setSyncTarget(document.documentElement);
  }, []);

  // Body-scroll lock + scrollbar-gutter compensation while the Cmd+K
  // modal is open. Inkeep's modal does not apply `overflow: hidden` /
  // padding compensation on `<html>` (verified at runtime: only
  // `body { pointer-events: none }` is added), so without this hook
  // the page body and any `position: fixed` children (e.g. the
  // `AskAIPill`) shift horizontally by the scrollbar width when the
  // scrollbar disappears. This mirrors the lock the `AskAIProvider`
  // applies for the assistant modal so both paths look identical.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!open) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousPaddingRight = root.style.paddingRight;
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    if (scrollbarWidth > 0) {
      root.style.paddingRight = `${scrollbarWidth}px`;
    }
    root.style.overflow = 'hidden';
    root.style.setProperty('--ask-ai-scrollbar-gutter', `${scrollbarWidth}px`);
    return () => {
      root.style.overflow = previousOverflow;
      root.style.paddingRight = previousPaddingRight;
      root.style.removeProperty('--ask-ai-scrollbar-gutter');
    };
  }, [open]);

  // Lazy-mount: see comment in `ask-ai-legacy-shell.tsx`. Fumadocs's
  // `RootProvider` always mounts this `SearchDialog`, which means the
  // Inkeep tree (and its inline `<script>`) was being added to every
  // page render. Holding the modal out of the tree until the user
  // first triggers Cmd/Ctrl+K removes the warning from the initial
  // GET / hydration; the widget then stays alive across close/reopen
  // so query history and session state are preserved.
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false);
  if (open && !hasOpenedOnce) {
    setHasOpenedOnce(true);
  }

  const config: InkeepModalSearchAndChatProps = {
    baseSettings: {
      apiKey: process.env.NEXT_PUBLIC_INKEEP_API_KEY!,
      primaryBrandColor: '#16E3C1',
      organizationDisplayName: 'QVAC',
      colorMode: {
        sync: {
          target: syncTarget,
          attributes: ['class'],
          isDarkMode: (attributes) => !!attributes.class?.includes('dark'),
        },
      },
    },
    modalSettings: {
      isOpen: open,
      onOpenChange,
      // Avoid reacting to the default `[data-inkeep-modal-trigger]` custom
      // trigger, since the site also has a chat trigger and we don't want
      // both modals opening.
      triggerSelector: '[data-inkeep-modal-trigger="search"]',
    },
    searchSettings: {},
    defaultView: 'search',
    aiChatSettings: {
      aiAssistantAvatar: '/qvac-icon.svg',
      exampleQuestions: [
        'What is QVAC?',
        'Why Tether built QVAC?',
        'How to use QVAC?',
      ],
    },
    onToggleView: ({ view, query, autoSubmit }) => {
      // Only hijack switching INTO the chat view; switching back to
      // search should be left to the modal.
      if (view !== 'chat') return;

      // Route into our own chat shell so the conversation lives in
      // one place no matter how the user got there.
      onOpenChange(false);
      const trimmed = query?.trim();
      if (trimmed && autoSubmit !== false) {
        askAI.openWith(trimmed);
      } else {
        askAI.open();
      }
    },
  };

  if (!hasOpenedOnce) return null;

  return <InkeepModalSearchAndChat {...config} />;
}
