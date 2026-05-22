'use client';

import {
  type AIChatFunctions,
  type InkeepModalSearchAndChatProps,
} from '@inkeep/cxkit-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AskAIContextSnippet,
  useAskAI,
} from '@/components/ask-ai';

const InkeepModalSearchAndChat = dynamic(
  () =>
    import('@inkeep/cxkit-react').then((m) => ({
      default: m.InkeepModalSearchAndChat,
    })),
  { ssr: false, loading: () => null },
);

const MAX_FLUSH_ATTEMPTS = 30;

/**
 * Format a queued context snippet (text selection or code block) as
 * a Markdown block we can either auto-submit alongside a prompt or
 * stage in the chat input for the user to finish typing. Mirrors the
 * format used by the existing `AskAIChatShell` so the assistant
 * receives the same shape regardless of which surface is active.
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
 * Drop-in chat surface that replaces the buggy `AskAIDesktopShell` /
 * `AskAIChatShell` while we keep the Mintlify-style components in
 * `/components/ask-ai/` preserved for future repair. Mounts a single
 * `InkeepModalSearchAndChat` (chat-first) controlled by the same
 * `useAskAI()` provider state every existing trigger already feeds:
 * top-nav button, code-block sparkles, page-actions sparkles,
 * text-selection popup, deep-link `?assistant=`, hotkey `Cmd/Ctrl+I`,
 * and the Cmd/Ctrl+K search modal hijack.
 *
 * The Inkeep modal is the same component used by the search dialog,
 * so visually search and Ask AI become consistent — both are
 * centered modals over a backdrop.
 */
export function AskAILegacyShell() {
  const askAI = useAskAI();
  const apiKey = process.env.NEXT_PUBLIC_INKEEP_API_KEY;
  const [syncTarget, setSyncTarget] = useState<HTMLElement | null>(null);
  const chatFunctionsRef = useRef<AIChatFunctions | null>(null);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      setSyncTarget(document.documentElement);
    }
  }, []);

  const isOpen = askAI.modalState !== 'closed';

  // Lazy-mount the Inkeep modal: keep it absent from the React tree
  // until the user actually opens the assistant for the first time.
  // Inkeep's internal `ColorModeProvider` renders an inline `<script>`
  // that triggers React 19's "Encountered a script tag while rendering
  // React component" warning whenever the tree is rendered on the
  // client. Mounting only on first open removes the warning from the
  // initial GET / hydration; once mounted, the widget stays alive so
  // its conversation state is preserved across close/reopen.
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false);
  if (isOpen && !hasOpenedOnce) {
    setHasOpenedOnce(true);
  }

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) askAI.close();
    },
    [askAI],
  );

  // Drain queued prompt / context as soon as the modal is open AND
  // Inkeep has populated `chatFunctionsRef.current`. Inkeep mounts
  // its imperative API asynchronously, so we poll via rAF until
  // either the API is ready (and we send) or we hit the attempt cap.
  useEffect(() => {
    if (!isOpen) return;
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;

    let cancelled = false;
    let attempts = 0;

    function tryFlush() {
      if (cancelled) return;
      const fns = chatFunctionsRef.current;
      if (!fns) {
        if (attempts++ < MAX_FLUSH_ATTEMPTS) {
          requestAnimationFrame(tryFlush);
        }
        return;
      }

      const contextBlock = context ? renderContextBlock(context) : '';
      if (prompt) {
        const composed = `${contextBlock}${prompt}`.trim();
        fns.submitMessage(composed);
      } else if (context) {
        fns.updateInputMessage(contextBlock);
        fns.focusInput();
      }

      askAI.clearPending();
    }

    requestAnimationFrame(tryFlush);

    return () => {
      cancelled = true;
    };
  }, [isOpen, askAI.pendingPrompt, askAI.pendingContext, askAI]);

  const config = useMemo<InkeepModalSearchAndChatProps | null>(() => {
    if (!apiKey || !syncTarget) return null;
    return {
      baseSettings: {
        apiKey,
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
        isOpen,
        onOpenChange,
        // Dummy selector so Inkeep does not auto-open on generic
        // `[data-inkeep-modal-trigger]` elements that the Cmd+K
        // search dialog also listens for.
        triggerSelector: '[data-inkeep-ask-ai-legacy-trigger]',
      },
      searchSettings: {},
      defaultView: 'chat',
      // `forceDefaultView: true` ensures the modal always opens on
      // the chat tab (not search), even after the user previously
      // toggled the view in the same session.
      forceDefaultView: true,
      aiChatSettings: {
        aiAssistantAvatar: '/qvac-icon.svg',
        exampleQuestions: [
          'What is QVAC?',
          'How do I run an LLM locally?',
          'How does P2P inference work?',
        ],
        chatFunctionsRef,
      },
    };
  }, [apiKey, syncTarget, isOpen, onOpenChange]);

  if (!config || !hasOpenedOnce) return null;

  return <InkeepModalSearchAndChat {...config} />;
}
