'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AIChatFunctions,
  InkeepBaseSettings,
} from '@inkeep/cxkit-types';
import type {
  InkeepModalSearchAndChatProps,
  InkeepSidebarChatProps,
} from '@inkeep/cxkit-react';

import { useAskAI } from './ask-ai-provider';
import type { AskAIContextSnippet } from './types';

// `@inkeep/cxkit-react` weighs ~1.35 MB minified. Loading it via
// `next/dynamic` with `ssr: false` keeps it out of the critical-path
// bundle: the chat surfaces arrive in their own async chunk after
// hydration, so docs pages become interactive without waiting on the
// chat widget to parse. Same defer technique that was landed in commit
// d9572c014 for the previous floating chat button.
const InkeepSidebarChat = dynamic(
  () => import('@inkeep/cxkit-react').then((m) => ({ default: m.InkeepSidebarChat })),
  { ssr: false, loading: () => null },
);

const InkeepModalSearchAndChat = dynamic(
  () =>
    import('@inkeep/cxkit-react').then((m) => ({ default: m.InkeepModalSearchAndChat })),
  { ssr: false, loading: () => null },
);

const PRIMARY_BRAND_COLOR = '#16E3C1';
const ORGANIZATION_NAME = 'QVAC';
const AI_AVATAR = '/favicon.ico';
const EXAMPLE_QUESTIONS = [
  'What is QVAC?',
  'How do I get started with QVAC?',
  'How do I embed QVAC in my app?',
];

/**
 * Hook that resolves to `document.documentElement` after the first client
 * render. Used so Inkeep can mirror the docs site's `class="dark"` /
 * `class="light"` theme attribute. Returning `null` until then prevents
 * Inkeep from being rendered with a stale SSR target.
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
 * Best-effort flush of a queued prompt / context snippet into a freshly
 * opened chat surface. The Inkeep ref isn't guaranteed to be populated
 * the moment `isOpen` flips to `true` — the underlying portal needs a
 * tick to mount — so we retry on the next animation frames until either
 * the ref appears or we exceed the budget.
 */
function flushPending(
  ref: React.RefObject<AIChatFunctions | null>,
  prompt: string | null,
  context: AskAIContextSnippet | null,
) {
  if (!prompt && !context) return;

  let attempts = 0;
  const MAX_ATTEMPTS = 30;

  function tick() {
    const fns = ref.current;
    if (!fns) {
      if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tick);
      return;
    }

    const contextBlock = context ? renderContextBlock(context) : '';

    if (prompt) {
      // Submit context + prompt as a single user message via the
      // documented `submitMessage(override)` API, which bypasses the
      // chat's current input value.
      fns.submitMessage(`${contextBlock}${prompt}`);
      return;
    }

    if (context) {
      // No prompt yet — stage the context in the input so the user can
      // finish typing their question.
      fns.updateInputMessage(contextBlock);
      fns.focusInput();
    }
  }

  requestAnimationFrame(tick);
}

interface DesktopSidebarProps {
  baseSettings: InkeepBaseSettings;
  aiChatSettings: NonNullable<InkeepSidebarChatProps['aiChatSettings']>;
}

function DesktopSidebar({ baseSettings, aiChatSettings }: DesktopSidebarProps) {
  const askAI = useAskAI();
  const chatFunctionsRef = useRef<AIChatFunctions | null>(null);

  useEffect(() => {
    if (!askAI.sidebarOpen) return;
    const prompt = askAI.takePendingPrompt();
    const context = askAI.takePendingContext();
    flushPending(chatFunctionsRef, prompt, context);
    // We intentionally depend only on `sidebarOpen`: every time the user
    // re-opens the sidebar we want to drain whatever is currently queued.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.sidebarOpen]);

  // Inkeep's `InkeepSidebarChat` has `position: relative; height: 100%; width: var(--width)` —
  // it does NOT self-position as a fixed overlay, it expects to live inside a
  // sized container. We wrap it in a viewport-fixed shell so the sidebar
  // slides in/out from the right edge of the screen at full viewport height.
  // The `[data-sidebar]` attribute is required by Inkeep's `[data-sidebar] &`
  // utility selectors. The wrapper itself stays `pointer-events-none` so the
  // empty space next to the sidebar never blocks clicks on the underlying
  // page; the sidebar element re-enables pointer events for itself.
  return (
    <div
      data-sidebar=""
      data-ask-ai-sidebar-shell=""
      className="pointer-events-none fixed inset-y-0 right-0 z-40 flex h-screen [&_[data-state=open]]:pointer-events-auto"
    >
      <InkeepSidebarChat
        baseSettings={baseSettings}
        aiChatSettings={{ ...aiChatSettings, chatFunctionsRef }}
        position="right"
        defaultWidth={420}
        minWidth={320}
        maxWidth={600}
        isOpen={askAI.sidebarOpen}
        onOpenChange={askAI.setSidebarOpen}
      />
    </div>
  );
}

interface MobileModalProps {
  baseSettings: InkeepBaseSettings;
  aiChatSettings: NonNullable<InkeepModalSearchAndChatProps['aiChatSettings']>;
}

function MobileModal({ baseSettings, aiChatSettings }: MobileModalProps) {
  const askAI = useAskAI();
  const chatFunctionsRef = useRef<AIChatFunctions | null>(null);

  useEffect(() => {
    if (!askAI.modalOpen) return;
    const prompt = askAI.takePendingPrompt();
    const context = askAI.takePendingContext();
    flushPending(chatFunctionsRef, prompt, context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.modalOpen]);

  return (
    <InkeepModalSearchAndChat
      baseSettings={baseSettings}
      aiChatSettings={{ ...aiChatSettings, chatFunctionsRef }}
      defaultView="chat"
      forceDefaultView
      modalSettings={{
        isOpen: askAI.modalOpen,
        onOpenChange: askAI.setModalOpen,
        // Disable Inkeep's auto-open on `[data-inkeep-modal-trigger]`
        // clicks. All opens go through `useAskAI()` so multiple triggers
        // never race each other.
        triggerSelector: '[data-inkeep-ask-ai-mobile-trigger]',
      }}
    />
  );
}

/**
 * Mounts both assistant surfaces simultaneously. The Tailwind wrappers
 * make sure only one is visible per viewport — the desktop sidebar is
 * hidden below `md` and the mobile chat modal is hidden at `md` and up.
 * Because both surfaces are controlled via separate booleans on the
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
    };
  }, [apiKey, colorModeSyncTarget]);

  const aiChatSettings = useMemo(
    () => ({
      aiAssistantAvatar: AI_AVATAR,
      exampleQuestions: EXAMPLE_QUESTIONS,
    }),
    [],
  );

  if (!baseSettings) return null;

  return (
    <>
      <div className="hidden md:contents">
        <DesktopSidebar baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
      <div className="contents md:hidden">
        <MobileModal baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
    </>
  );
}
