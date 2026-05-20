'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AIChatFunctions,
  InkeepBaseSettings,
} from '@inkeep/cxkit-types';
import type {
  InkeepEmbeddedChatProps,
  InkeepModalSearchAndChatProps,
} from '@inkeep/cxkit-react';

import { useAskAI } from './ask-ai-provider';
import { AskAIDesktopShell } from './ask-ai-desktop-shell';
import type { AskAIContextSnippet } from './types';

// `@inkeep/cxkit-react` weighs ~1.35 MB minified. The mobile
// full-screen modal is also lazy-loaded so the docs page becomes
// interactive without waiting on the chat widget to parse.
const InkeepModalSearchAndChat = dynamic(
  () =>
    import('@inkeep/cxkit-react').then((m) => ({ default: m.InkeepModalSearchAndChat })),
  { ssr: false, loading: () => null },
);

const PRIMARY_BRAND_COLOR = '#16E3C1';
const ORGANIZATION_NAME = 'QVAC';
const AI_AVATAR = '/favicon.ico';
const INPUT_PLACEHOLDER = 'Ask a question\u2026';

// CSS injected into Inkeep's Shadow DOM via `baseSettings.theme.styles`.
// The widget renders inside an isolated Shadow DOM, so styles defined
// in the docs site's normal stylesheets cannot reach these elements;
// `theme.styles` is the documented hook for that.
//
// All selectors are intentionally limited to exact `[data-_id="..."]`
// and `.ikp-...` (kebab-case bare class) forms. The earlier
// `[class*="..."]` partial-match form proved too aggressive and
// matched non-target elements inside the input subtree, breaking
// typing in the chat.
//
// Two rules in play:
//   1. Hide the default intro greeting (we also set introMessage: ''
//      on aiChatSettings, but Inkeep falls back to a default bubble
//      when the prop is empty - belt-and-suspenders).
//   2. Hide the assistant-message avatar so messages render flush-left
//      without a panel-inside-a-panel feel.
const INKEEP_CUSTOM_CSS = `
  .ikp-ai-chat__assistant-avatar,
  [data-_id="aiChat__AssistantAvatar"],
  [data-_id="aiChat__assistantAvatar"] {
    display: none !important;
  }

  .ikp-ai-chat-intro-message,
  [data-_id="aiChat__IntroMessage"],
  [data-_id="aiChat__introMessage"] {
    display: none !important;
  }
`;

/**
 * Hook that resolves to `document.documentElement` after the first
 * client render. Used so Inkeep can mirror the docs site's
 * `class="dark"` / `class="light"` theme attribute. Returning `null`
 * until then prevents Inkeep from being rendered with a stale SSR
 * target.
 */
function useColorModeSyncTarget(): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.documentElement);
  }, []);
  return target;
}

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
 * mobile full-screen modal. Same logic as the desktop-shell flush
 * (retries on rAF until `chatFunctionsRef.current` is populated, then
 * stages text via `updateInputMessage` and submits explicitly).
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

interface MobileModalProps {
  baseSettings: InkeepBaseSettings;
  aiChatSettings: NonNullable<InkeepModalSearchAndChatProps['aiChatSettings']>;
}

function MobileModal({ baseSettings, aiChatSettings }: MobileModalProps) {
  const askAI = useAskAI();
  const chatFunctionsRef = useRef<AIChatFunctions | null>(null);

  useEffect(() => {
    if (!askAI.mobileModalOpen) return;
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;
    flushPending(chatFunctionsRef, prompt, context);
    askAI.clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.mobileModalOpen, askAI.pendingPrompt, askAI.pendingContext]);

  return (
    <InkeepModalSearchAndChat
      baseSettings={baseSettings}
      aiChatSettings={{ ...aiChatSettings, chatFunctionsRef }}
      defaultView="chat"
      forceDefaultView
      modalSettings={{
        isOpen: askAI.mobileModalOpen,
        onOpenChange: askAI.setMobileModalOpen,
        // Disable Inkeep's auto-open on `[data-inkeep-modal-trigger]`
        // clicks. All opens go through `useAskAI()` so multiple
        // triggers never race each other.
        triggerSelector: '[data-inkeep-ask-ai-mobile-trigger]',
      }}
    />
  );
}

/**
 * Mounts both assistant surfaces simultaneously. The Tailwind wrappers
 * make sure only one is visible per viewport - the desktop shell is
 * hidden below `md` and the mobile chat modal is hidden at `md` and up.
 * Because the two surfaces are controlled by separate state on the
 * `AskAIProvider`, leaving them both mounted has no UX impact: the
 * hidden one never opens.
 */
export function AskAIShell() {
  const apiKey = process.env.NEXT_PUBLIC_INKEEP_API_KEY;
  const colorModeSyncTarget = useColorModeSyncTarget();

  const baseSettings = useMemo<InkeepBaseSettings | null>(() => {
    if (!apiKey || !colorModeSyncTarget) return null;
    return {
      apiKey,
      primaryBrandColor: PRIMARY_BRAND_COLOR,
      organizationDisplayName: ORGANIZATION_NAME,
      colorMode: {
        sync: {
          target: colorModeSyncTarget,
          attributes: ['class'],
          isDarkMode: (attributes) => !!attributes.class?.includes('dark'),
        },
      },
      theme: {
        styles: [
          {
            key: 'qvac-ask-ai-overrides',
            type: 'style',
            value: INKEEP_CUSTOM_CSS,
          },
        ],
      },
    };
  }, [apiKey, colorModeSyncTarget]);

  // Strip the default greeting and example-questions row so the chat
  // surface opens straight to the input - matches the reviewed UX. The
  // empty `introMessage` covers the welcome bubble; `exampleQuestions:
  // []` removes the suggestion chips above it. `placeholder` overrides
  // the built-in "How do I get started..." hint.
  const aiChatSettings = useMemo<NonNullable<InkeepEmbeddedChatProps['aiChatSettings']>>(
    () => ({
      aiAssistantAvatar: AI_AVATAR,
      placeholder: INPUT_PLACEHOLDER,
      introMessage: '',
      exampleQuestions: [],
    }),
    [],
  );

  if (!baseSettings) return null;

  return (
    <>
      <div className="hidden md:contents">
        <AskAIDesktopShell baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
      <div className="contents md:hidden">
        <MobileModal baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
    </>
  );
}
