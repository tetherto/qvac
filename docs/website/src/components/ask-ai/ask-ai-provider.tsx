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
 * Tailwind `md` breakpoint. Mirrors `md:` used in the rest of the app so
 * the JS-side switch lines up with the CSS-side hide/show on the desktop
 * shell vs mobile `InkeepModalSearchAndChat`. Hardcoding the value here
 * keeps the provider free of any Tailwind config dependency.
 */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

export type AskAISurface = 'desktop' | 'mobile';

/**
 * Desktop chat surface state machine:
 *
 *  - `closed`   - only the bottom-anchored bar is showing. The user can
 *                 type a question into the bar's input, which submits
 *                 and transitions to `open`.
 *  - `open`     - bar morphs into a modal with the chat history above
 *                 the input. Modal width matches the docs body column;
 *                 the input stays in the same screen position so the
 *                 transition reads as the bar growing.
 *  - `expanded` - same modal, expanded to fill the viewport.
 *
 * The conversation is preserved across `open` <-> `closed` because the
 * `InkeepEmbeddedChat` instance inside the shell stays mounted; only
 * the wrapper's CSS state changes.
 */
export type AskAIDesktopState = 'closed' | 'open' | 'expanded';

export interface AskAIContextValue {
  /** True once the provider has run on the client; before that, do not
   *  read viewport-dependent fields, they are deliberately defaults. */
  isReady: boolean;

  /** Which surface the provider is currently routing triggers to. */
  surface: AskAISurface;

  /** Desktop chat surface state. */
  desktopState: AskAIDesktopState;
  /** Open the desktop modal in body-width state. No-op on mobile. */
  openModal: () => void;
  /** Collapse the desktop modal back to the bar. No-op on mobile. */
  closeModal: () => void;
  /** Toggle between `open` and `expanded`. Only meaningful when the
   *  desktop modal is already open. */
  toggleExpand: () => void;

  /** Whether the mobile chat-first modal is currently open. */
  mobileModalOpen: boolean;
  setMobileModalOpen: (open: boolean) => void;

  /** Queued prompt that should be auto-submitted as soon as the active
   *  surface is mounted and ready. Drained by the shell. */
  pendingPrompt: string | null;
  /** Queued context (selected text or code snippet) to prepend to the
   *  next user input. Drained by the shell. */
  pendingContext: AskAIContextSnippet | null;

  /** Open the assistant on whichever surface the viewport calls for.
   *  Desktop -> `openModal()`; mobile -> `setMobileModalOpen(true)`. */
  open: () => void;
  /** Close every assistant surface. */
  close: () => void;
  /** Toggle the active surface open/closed (between `closed` and `open`
   *  on desktop; never targets `expanded`). */
  toggle: () => void;
  /** Open the assistant and queue `prompt` to be auto-submitted. */
  openWith: (prompt: string) => void;
  /** Open the assistant and queue `snippet` to be prepended to the input. */
  addContext: (snippet: AskAIContextSnippet) => void;

  /** Clear the queued prompt and/or context. The shell calls this once
   *  after consuming the values from `pendingPrompt` / `pendingContext`. */
  clearPending: () => void;
}

const noop = () => {};

const defaultValue: AskAIContextValue = {
  isReady: false,
  surface: 'desktop',
  desktopState: 'closed',
  openModal: noop,
  closeModal: noop,
  toggleExpand: noop,
  mobileModalOpen: false,
  setMobileModalOpen: noop,
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

function useIsDesktop(): { isReady: boolean; isDesktop: boolean } {
  const [state, setState] = useState({ isReady: false, isDesktop: true });

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const handler = () => setState({ isReady: true, isDesktop: mq.matches });
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return state;
}

/**
 * Returns true when the user is currently typing into a regular form
 * field. Used to gate keyboard shortcuts so we never steal `Cmd+I` from
 * an editor or search input the user is interacting with.
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
  const { isReady, isDesktop } = useIsDesktop();
  const [desktopState, setDesktopState] = useState<AskAIDesktopState>('closed');
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingContext, setPendingContext] = useState<AskAIContextSnippet | null>(null);

  const surface: AskAISurface = isDesktop ? 'desktop' : 'mobile';

  // Refs let `open`/`close`/`toggle` stay stable across re-renders while
  // still reading the freshest viewport / open-state values. Without
  // this, every viewport resize would invalidate every memoised trigger
  // (which there are many of: header button, bottom bar, hotkey listener,
  // URL handler, code block, text-selection popup).
  const isDesktopRef = useRef(isDesktop);
  const desktopStateRef = useRef(desktopState);
  const mobileModalOpenRef = useRef(mobileModalOpen);
  isDesktopRef.current = isDesktop;
  desktopStateRef.current = desktopState;
  mobileModalOpenRef.current = mobileModalOpen;

  // ---------------------------------------------------------------------------
  // Desktop-specific actions
  // ---------------------------------------------------------------------------
  const openModal = useCallback(() => {
    // Always open into 'open' state (body-width). Per the agreed UX,
    // triggers never jump straight to 'expanded'; the user opts in via
    // the expand affordance inside the modal.
    setDesktopState((current) => (current === 'expanded' ? current : 'open'));
  }, []);

  const closeModal = useCallback(() => {
    setDesktopState('closed');
  }, []);

  const toggleExpand = useCallback(() => {
    setDesktopState((current) => {
      if (current === 'open') return 'expanded';
      if (current === 'expanded') return 'open';
      // From 'closed': open into expanded would surprise users; ignore.
      return current;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Cross-surface convenience helpers used by triggers that don't care
  // which viewport is active (header button, hotkey, deep link, code
  // block, text selection, page-actions popover).
  // ---------------------------------------------------------------------------
  const open = useCallback(() => {
    if (isDesktopRef.current) {
      // Same logic as openModal but inline to avoid a callback dep.
      setDesktopState((current) => (current === 'expanded' ? current : 'open'));
    } else {
      setMobileModalOpen(true);
    }
  }, []);

  const close = useCallback(() => {
    setDesktopState('closed');
    setMobileModalOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (isDesktopRef.current) {
      setDesktopState((current) => (current === 'closed' ? 'open' : 'closed'));
    } else {
      setMobileModalOpen((v) => !v);
    }
  }, []);

  const openWith = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (trimmed.length > 0) setPendingPrompt(trimmed);
      open();
    },
    [open],
  );

  const addContext = useCallback(
    (snippet: AskAIContextSnippet) => {
      setPendingContext(snippet);
      open();
    },
    [open],
  );

  // The shell consumes `pendingPrompt` / `pendingContext` directly from
  // the context (they're already in the render closure), then calls
  // `clearPending` to drain the queue. We deliberately do NOT use the
  // "read+clear in a single call" pattern here: in React 19 concurrent
  // mode the functional state setter's updater runs on the NEXT render
  // pass, not synchronously, so any value captured inside the updater
  // is unavailable to the caller.
  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingContext(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Cmd/Ctrl+I global hotkey. Toggles the assistant between `closed` and
  // `open` (never targets `expanded`).
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // `?assistant=open` and `?assistant=<query>` deep links. We strip the
  // param from the URL once consumed so reloading the page does not re-
  // open the assistant unexpectedly. The handler runs once per distinct
  // search-string instance, not per render.
  // ---------------------------------------------------------------------------
  const searchParams = useSearchParams();
  const lastConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searchParams) return;
    const value = searchParams.get('assistant');
    if (value === null) return;
    // The same `useSearchParams()` instance object can fire multiple
    // effects; gate on the actual string to dedupe.
    const fingerprint = `${value}::${searchParams.toString()}`;
    if (lastConsumedRef.current === fingerprint) return;
    lastConsumedRef.current = fingerprint;

    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'open' || trimmed === 'true' || trimmed === '1') {
      open();
    } else {
      openWith(trimmed);
    }

    // Strip the param from the URL bar without triggering a navigation.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('assistant');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, [searchParams, open, openWith]);

  const value = useMemo<AskAIContextValue>(
    () => ({
      isReady,
      surface,
      desktopState,
      openModal,
      closeModal,
      toggleExpand,
      mobileModalOpen,
      setMobileModalOpen,
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
      surface,
      desktopState,
      openModal,
      closeModal,
      toggleExpand,
      mobileModalOpen,
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
 * Provides the assistant state to the entire docs site. Wraps the inner
 * implementation in a Suspense boundary because `useSearchParams` requires
 * one when the app is statically exported (`output: 'export'`).
 */
export function AskAIProvider({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AskAIContext.Provider value={defaultValue}>{children}</AskAIContext.Provider>}>
      <AskAIProviderInner>{children}</AskAIProviderInner>
    </Suspense>
  );
}
