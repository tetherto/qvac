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
      aiAssistantAvatar: '/qvac-favicon.ico',
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

  return <InkeepModalSearchAndChat {...config} />;
}
