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
 * dialog. On every breakpoint it stays a search-first modal, but on
 * desktop we hijack the in-modal "Ask AI" tab and forward to the
 * persistent sidebar so the docs site has exactly one chat
 * conversation surface, matching Mintlify's behavior. On mobile the
 * tab toggle is allowed to flip the modal into chat view normally,
 * because the sidebar is not available there.
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

      // On desktop, route every chat into the centered AskAI modal so
      // the user keeps a single conversation across surfaces. On mobile
      // we let the in-modal chat experience take over (no separate
      // desktop modal exists there).
      if (askAI.surface !== 'desktop') return;

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
