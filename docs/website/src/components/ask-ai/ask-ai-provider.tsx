'use client';

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';

import type { AskAIContextSnippet } from './types';

/**
 * Chat-modal state machine. Same surface on every breakpoint - the
 * shell responds to its container size, not to viewport detection.
 *
 *  - `closed`   - only the bottom-anchored bar is visible. Typing in
 *                 the bar + submitting transitions to `open`.
 *  - `open`     - bar morphs into a modal with the chat history above
 *                 the input. Modal width matches the docs body column
 *                 on desktop and goes near-full-screen on mobile via
 *                 responsive CSS. The bottom-anchored input stays in
 *                 the same visual position.
 *  - `expanded` - same modal expanded to fill the viewport (desktop
 *                 expand toggle; on mobile the modal is already at
 *                 max size so the toggle is hidden).
 *
 * Conversation state lives in the chat hook inside the shell, which
 * stays mounted across these transitions - so collapsing to the bar
 * never loses messages.
 */
export type AskAIModalState = 'closed' | 'open' | 'expanded';

export interface AskAIContextValue {
  /** True once the provider has run on the client; before that, do
   *  not read viewport-dependent fields, they are deliberately
   *  defaults. Kept here even though the shell is no longer
   *  viewport-branched - other consumers can still gate on it. */
  isReady: boolean;

  /** Chat modal state, identical on desktop and mobile. */
  modalState: AskAIModalState;
  /** Open the modal in body-width state. No-op if already open. */
  openModal: () => void;
  /** Close the modal back to the bar. No-op if already closed. */
  closeModal: () => void;
  /** Toggle between `open` and `expanded`. From `closed` this is a
   *  no-op (the user must first open the modal). */
  toggleExpand: () => void;

  /** Queued prompt that should be auto-submitted as soon as the chat
   *  shell mounts / the chat hook is ready. Drained by the shell. */
  pendingPrompt: string | null;
  /** Queued context (selected text or code snippet) to prepend to
   *  the next user input. Drained by the shell. */
  pendingContext: AskAIContextSnippet | null;

  /** Open the assistant. Alias for `openModal()` kept for the
   *  triggers that already call `open()`. */
  open: () => void;
  /** Close the assistant. Alias for `closeModal()`. */
  close: () => void;
  /** Toggle between `closed` and `open` (never targets `expanded`). */
  toggle: () => void;
  /** Open the assistant and queue `prompt` to be auto-submitted. */
  openWith: (prompt: string) => void;
  /** Open the assistant and queue `snippet` to be prepended to the
   *  input. Used by the code-block "Ask AI" button and the text-
   *  selection "Add to assistant" popup. */
  addContext: (snippet: AskAIContextSnippet) => void;

  /** Clear the queued prompt and/or context. The shell calls this
   *  once after consuming the values from `pendingPrompt` /
   *  `pendingContext`. */
  clearPending: () => void;
}

const noop = () => {};

const defaultValue: AskAIContextValue = {
  isReady: false,
  modalState: 'closed',
  openModal: noop,
  closeModal: noop,
  toggleExpand: noop,
  pendingPrompt: null,
  pendingContext: null,
  open: noop,
  close: noop,
  toggle: noop,
  openWith: noop,
  addContext: noop,
  clearPending: noop,
};

const AskAIContext = createContext<AskAIContextValue>(defaultValue);

/**
 * Read the assistant context from any client component. Safe to call
 * outside the provider (returns inert no-ops).
 */
export function useAskAI(): AskAIContextValue {
  return useContext(AskAIContext);
}

/**
 * Returns true when the user is currently typing into a regular form
 * field. Used to gate keyboard shortcuts so we never steal `Cmd+I`
 * from an editor or search input the user is interacting with.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface AskAIProviderInnerProps {
  children: React.ReactNode;
}

function AskAIProviderInner({ children }: AskAIProviderInnerProps) {
  const [modalState, setModalState] = useState<AskAIModalState>('closed');
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingContext, setPendingContext] = useState<AskAIContextSnippet | null>(null);
  // We expose `isReady` for forward-compat; mark it true after the
  // first commit so legacy gates clear without ever blocking.
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    setIsReady(true);
  }, []);

  // ---------------------------------------------------------------
  // Modal actions
  // ---------------------------------------------------------------
  const openModal = useCallback(() => {
    setModalState((current) => (current === 'expanded' ? current : 'open'));
  }, []);

  const closeModal = useCallback(() => {
    setModalState('closed');
  }, []);

  const toggleExpand = useCallback(() => {
    setModalState((current) => {
      if (current === 'open') return 'expanded';
      if (current === 'expanded') return 'open';
      // From 'closed': jumping straight to 'expanded' would surprise
      // users; ignore.
      return current;
    });
  }, []);

  // ---------------------------------------------------------------
  // Cross-cutting helpers (back-compat with existing trigger call
  // sites: header button, hotkey, deep link, code block, text
  // selection, page-actions popover).
  // ---------------------------------------------------------------
  const open = openModal;
  const close = closeModal;

  const toggle = useCallback(() => {
    setModalState((current) => (current === 'closed' ? 'open' : 'closed'));
  }, []);

  const openWith = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length > 0) setPendingPrompt(trimmed);
      openModal();
    },
    [openModal],
  );

  const addContext = useCallback(
    (snippet: AskAIContextSnippet) => {
      setPendingContext(snippet);
      openModal();
    },
    [openModal],
  );

  // The shell consumes `pendingPrompt` / `pendingContext` directly
  // from the context (they're already in the render closure), then
  // calls `clearPending` to drain the queue. We deliberately do NOT
  // use the "read+clear in a single call" pattern here: in React 19
  // concurrent mode the functional state setter's updater runs on
  // the NEXT render pass, not synchronously, so any value captured
  // inside the updater is unavailable to the caller.
  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingContext(null);
  }, []);

  // ---------------------------------------------------------------
  // Body-scroll lock. Page must NOT scroll behind the open modal
  // (per the review). We lock `documentElement` rather than `body`
  // because Fumadocs's layout sets its own overflow on `body`.
  // ---------------------------------------------------------------
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (modalState === 'closed') return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousPaddingRight = root.style.paddingRight;
    // Measure the scrollbar gutter before hiding overflow so we can
    // pad the page by the same amount, preventing the body from
    // jumping right when the scrollbar disappears under the modal.
    // Mirrors what `react-remove-scroll` (used by Radix Dialog inside
    // Inkeep's search modal) does in the Cmd+K path - so opening the
    // assistant now matches Cmd+K visually.
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    if (scrollbarWidth > 0) {
      root.style.paddingRight = `${scrollbarWidth}px`;
    }
    root.style.overflow = 'hidden';
    // Publish the gutter as a CSS custom property so any
    // `position: fixed` element (e.g. `AskAIPill`) can reserve the
    // same width and avoid being recentered when the scrollbar is
    // removed from the ICB. Only fixed-positioned children need
    // this; flow-positioned content already inherits the
    // documentElement padding.
    root.style.setProperty('--ask-ai-scrollbar-gutter', `${scrollbarWidth}px`);
    return () => {
      root.style.overflow = previousOverflow;
      root.style.paddingRight = previousPaddingRight;
      root.style.removeProperty('--ask-ai-scrollbar-gutter');
    };
  }, [modalState]);

  // ---------------------------------------------------------------
  // Cmd/Ctrl+I global hotkey. Toggles `closed <-> open` (never
  // targets `expanded`).
  // ---------------------------------------------------------------
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'i') return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  // ---------------------------------------------------------------
  // `?assistant=open` and `?assistant=<query>` deep links. We strip
  // the param from the URL once consumed so reloading the page does
  // not re-open the assistant unexpectedly.
  // ---------------------------------------------------------------
  const searchParams = useSearchParams();
  const lastConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searchParams) return;
    const value = searchParams.get('assistant');
    if (value === null) return;
    const fingerprint = `${value}::${searchParams.toString()}`;
    if (lastConsumedRef.current === fingerprint) return;
    lastConsumedRef.current = fingerprint;

    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'open' || trimmed === 'true' || trimmed === '1') {
      openModal();
    } else {
      openWith(trimmed);
    }

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('assistant');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, [searchParams, openModal, openWith]);

  const value = useMemo<AskAIContextValue>(
    () => ({
      isReady,
      modalState,
      openModal,
      closeModal,
      toggleExpand,
      pendingPrompt,
      pendingContext,
      open,
      close,
      toggle,
      openWith,
      addContext,
      clearPending,
    }),
    [
      isReady,
      modalState,
      openModal,
      closeModal,
      toggleExpand,
      pendingPrompt,
      pendingContext,
      open,
      close,
      toggle,
      openWith,
      addContext,
      clearPending,
    ],
  );

  return <AskAIContext.Provider value={value}>{children}</AskAIContext.Provider>;
}

/**
 * Provides the assistant state to the entire docs site. Wraps the
 * inner implementation in a Suspense boundary because
 * `useSearchParams` requires one when the app is statically exported
 * (`output: 'export'`).
 */
export function AskAIProvider({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AskAIContext.Provider value={defaultValue}>{children}</AskAIContext.Provider>}>
      <AskAIProviderInner>{children}</AskAIProviderInner>
    </Suspense>
  );
}
