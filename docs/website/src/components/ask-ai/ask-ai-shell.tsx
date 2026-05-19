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

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';
import type { AskAIContextSnippet } from './types';

/** Default sidebar width (matches `defaultWidth` passed to Inkeep). */
const DESKTOP_DEFAULT_WIDTH = 420;
/** CSS custom property the Fumadocs grid reads to know how much room
 *  to leave for the assistant pane. See [global.css] for the `:has()`
 *  rule that maps this to `--fd-toc-width` on `#nd-docs-layout`. */
const PANE_WIDTH_VAR = '--qvac-ai-pane-width';

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
const INPUT_PLACEHOLDER = 'Ask a question\u2026';

// CSS injected into Inkeep's Shadow DOM via `baseSettings.theme.styles`.
// The widget renders inside an isolated Shadow DOM, so styles defined
// in the docs site's normal stylesheets cannot reach these elements;
// `theme.styles` is the documented hook for that.
//
// Inkeep does not publish a stable class-name contract, so every rule
// uses a triple-fallback selector list:
//   - `[data-_id="..."]`  - Inkeep's primitive id (most stable)
//   - `[class*="..."]`    - partial class match (camelCase variant)
//   - `.ikp-...`          - bare kebab-case class from older builds
// If any single selector misses upstream, the rest still apply; if all
// three miss, the rule is inert rather than breaking the widget.
//
// The five blocks below address the "clunky" feedback on the sidepane:
//   1. Resizer: revert to hover-only so the drag handle stops competing
//      with the page border for the user's attention.
//   2. Sidebar left edge: snap to `--color-fd-border` so it reads as a
//      continuation of the docs sidebar's right edge instead of a
//      third-party widget bolted on.
//   3. Header chrome: shrink the close button to ghost-density.
//   4. Assistant-message avatar: hide so messages render flush-left,
//      avoiding the "panel-inside-a-panel" look.
//   5. Spacing + input: pull the gutters in to match the docs density
//      and round the chat input into a soft pill that picks up our
//      `--color-fd-border` token.
//
// Belt-and-suspenders intro-message hide stays too: we also set
// `aiChatSettings.introMessage: ''` below, but Inkeep is known to fall
// back to a default greeting when the prop is empty.
const INKEEP_CUSTOM_CSS = `
  /* 1. Drag handle: hover-only (revert to Inkeep's native opacity-0). */
  .ikp-sidebar-chat__resizer,
  [class*="sidebarChat__Resizer"],
  [data-_id="sidebarChat__Resizer"] {
    opacity: 0 !important;
    transition: opacity 0.15s ease !important;
  }
  .ikp-sidebar-chat__resizer:hover,
  [class*="sidebarChat__Resizer"]:hover,
  [data-_id="sidebarChat__Resizer"]:hover {
    opacity: 1 !important;
  }

  /* 2. Sidebar left edge: match the docs divider token. */
  [data-sidebar][data-position="right"] {
    border-inline-start-color: var(--color-fd-border, currentColor) !important;
    border-inline-start-width: 1px !important;
  }

  /* 3. Header chrome: smaller, ghost-style close button. */
  .ikp-sidebar-chat__close-button,
  [class*="sidebarChat__CloseButton"],
  [data-_id="sidebarChat__CloseButton"] {
    width: 1.75rem !important;
    height: 1.75rem !important;
    color: var(--color-fd-muted-foreground, currentColor) !important;
    opacity: 0.85;
  }
  .ikp-sidebar-chat__close-button:hover,
  [class*="sidebarChat__CloseButton"]:hover,
  [data-_id="sidebarChat__CloseButton"]:hover {
    opacity: 1;
  }

  /* 4. Drop the heavyweight assistant avatar bubble in messages.
     Locked to EXACT-match selectors only - the partial-match form
     [class*="..."] proved too aggressive and was matching non-avatar
     elements inside the input subtree, breaking typing. */
  .ikp-ai-chat__assistant-avatar,
  [data-_id="aiChat__AssistantAvatar"],
  [data-_id="aiChat__assistantAvatar"] {
    display: none !important;
  }

  /* 5. Tighten the sidebar-chat header gutter to match the docs
     content density. Message-rail / input-container padding are
     intentionally left at Inkeep defaults - the partial-match
     selectors required to target them reliably also matched the
     input itself and disrupted focus handling. */
  .ikp-sidebar-chat__header,
  [data-_id="sidebarChat__Header"] {
    padding: 0.5rem 0.75rem !important;
  }

  /* Intro-message belt-and-suspenders (kept from prior round).
     Limited to exact-match selectors for the same reason as above. */
  .ikp-ai-chat-intro-message,
  [data-_id="aiChat__IntroMessage"],
  [data-_id="aiChat__introMessage"] {
    display: none !important;
  }
`;

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
 * opened chat surface.
 *
 * Why this is fiddlier than it looks:
 *
 *  1. The Inkeep `chatFunctionsRef` is only populated after Inkeep
 *     mounts inside its Shadow DOM. On the very first open the heavy
 *     `@inkeep/cxkit-react` chunk also has to download/parse, the
 *     Shadow DOM has to bootstrap, and Radix Presence has to finish
 *     its open animation. Any of these can push readiness past a few
 *     hundred milliseconds, so a short rAF budget would silently drop
 *     the prompt. We poll for ~3 seconds before giving up.
 *
 *  2. `submitMessage()` (no argument) reads Inkeep's internal `input`
 *     state via closure. If we call it on the same tick that Inkeep
 *     just mounted, the state may still hold the empty initial value —
 *     even after we just called `updateInputMessage`, because that
 *     setter is queued asynchronously by React and the imperative
 *     handle's closure captured the prior value. The fix is to pass
 *     the composed text DIRECTLY to `submitMessage(text)`, which
 *     accepts an override and bypasses the `input` state entirely.
 *
 * We still call `updateInputMessage` first, so if `submitMessage`
 * itself ever fails (rare — only the loading-disabled gate or a hard
 * Inkeep error would trip it) the user at least sees their text staged
 * in the chat input and can press send manually.
 */
function flushPending(
  ref: React.RefObject<AIChatFunctions | null>,
  prompt: string | null,
  context: AskAIContextSnippet | null,
) {
  if (!prompt && !context) return;

  let attempts = 0;
  // ~3 seconds at 60 fps; covers the cold-start path where the Inkeep
  // chunk is being downloaded and parsed for the first time.
  const MAX_ATTEMPTS = 180;

  function tick() {
    const fns = ref.current;
    if (!fns) {
      if (++attempts < MAX_ATTEMPTS) requestAnimationFrame(tick);
      return;
    }

    const contextBlock = context ? renderContextBlock(context) : '';
    const composed = `${contextBlock}${prompt ?? ''}`;

    // Stage the composed text in the input first. Even if `submitMessage`
    // were to fail (rare — Inkeep's loading-disabled gate is the only
    // common path), the user still sees their text staged in the chat
    // input and can press send manually.
    fns.updateInputMessage(composed);
    fns.focusInput();

    if (!prompt) return;

    // Submit with an EXPLICIT override so we don't depend on Inkeep's
    // internal `input` state being in sync with our `updateInputMessage`
    // call (the imperative-handle closure may have captured a prior
    // value of the input state). Inkeep's `submitMessage(e)` falls back
    // to its internal state when `e` is undefined, but accepts a string
    // override that bypasses the lookup entirely.
    fns.submitMessage(composed);
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Drain queued prompt / context whenever EITHER the sidebar opens OR
  // a new pending payload arrives while it's already open. We read the
  // values directly off the render-captured context (they cannot change
  // between this render and the start of this effect) and only call
  // `clearPending` AFTER kicking off the flush — this avoids the React
  // 19 concurrent-mode trap where a functional state-setter's updater
  // runs on the next render pass instead of synchronously.
  useEffect(() => {
    if (!askAI.sidebarOpen) return;
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;
    flushPending(chatFunctionsRef, prompt, context);
    askAI.clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.sidebarOpen, askAI.pendingPrompt, askAI.pendingContext]);

  // Track the sidebar's live width and publish it to a global CSS var
  // so the Fumadocs grid can shrink the main column to make room (see
  // the `:has()` rule in `global.css`). Without this, the sidebar
  // would still overlay the page even though it lives at
  // `grid-area: toc` — Inkeep sets its width via an internal CSS var
  // on its own element, so the surrounding grid only sees the column's
  // intrinsic width if we measure and forward it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    if (!askAI.sidebarOpen) {
      root.style.removeProperty(PANE_WIDTH_VAR);
      return;
    }
    const node = wrapperRef.current;
    if (!node) return;

    const writeWidth = (width: number) => {
      // Round to whole pixels — sub-pixel writes cause unnecessary
      // grid reflows during the resize drag.
      root.style.setProperty(PANE_WIDTH_VAR, `${Math.round(width)}px`);
    };

    writeWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) writeWidth(entry.contentRect.width);
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      root.style.removeProperty(PANE_WIDTH_VAR);
    };
  }, [askAI.sidebarOpen]);

  // The wrapper has two layout personalities:
  //
  // - `< lg` (tablet / mobile): a viewport-fixed overlay anchored to
  //   the right edge. We never want to push the page sideways on
  //   small screens because there isn't enough horizontal room.
  // - `>= lg`: a real grid child of `#nd-docs-layout`, placed at
  //   `grid-area: toc`. Combined with the `:has()` rule in
  //   `global.css` and the `--qvac-ai-pane-width` write above, this
  //   makes the docs page main column shrink to leave room for the
  //   sidebar — i.e. true "push", not overlay.
  //
  // The `[data-sidebar]` attribute keeps Inkeep's `[data-sidebar] &`
  // descendant utility selectors happy. `data-qvac-ai-pane-open` is
  // the hook the global CSS uses to flip `--fd-toc-width`.
  return (
    <div
      ref={wrapperRef}
      data-sidebar=""
      data-ask-ai-sidebar-shell=""
      data-qvac-ai-pane-open={askAI.sidebarOpen ? '' : undefined}
      className={cn(
        'flex',
        'max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:h-screen',
        // `grid-area: toc` places us into the named area Fumadocs reserves
        // for the table of contents — that area already spans the three
        // grid rows (header / toc-popover / main), so no explicit row-span
        // is needed.
        'lg:sticky lg:top-0 lg:h-dvh lg:ms-auto lg:in-[#nd-docs-layout]:[grid-area:toc]',
      )}
    >
      <InkeepSidebarChat
        baseSettings={baseSettings}
        aiChatSettings={{ ...aiChatSettings, chatFunctionsRef }}
        position="right"
        defaultWidth={DESKTOP_DEFAULT_WIDTH}
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
    const prompt = askAI.pendingPrompt;
    const context = askAI.pendingContext;
    if (!prompt && !context) return;
    flushPending(chatFunctionsRef, prompt, context);
    askAI.clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAI.modalOpen, askAI.pendingPrompt, askAI.pendingContext]);

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
  // surface opens straight to the input — matches the reviewed UX. The
  // empty `introMessage` covers the welcome bubble; `exampleQuestions:
  // []` removes the suggestion chips above it. `placeholder` overrides
  // the built-in "How do I get started…" hint.
  const aiChatSettings = useMemo(
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
        <DesktopSidebar baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
      <div className="contents md:hidden">
        <MobileModal baseSettings={baseSettings} aiChatSettings={aiChatSettings} />
      </div>
    </>
  );
}
