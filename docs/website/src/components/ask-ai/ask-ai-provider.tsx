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
 * the JS-side switch lines up with the CSS-side hide/show on the shell
 * components (`InkeepSidebarChat` desktop / `InkeepModalSearchAndChat`
 * mobile). Hardcoding the value here keeps the provider free of any
 * Tailwind config dependency.
 */
const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

export type AskAISurface = 'sidebar' | 'modal';

export interface AskAIContextValue {
  /** True once the provider has run on the client; before that, do not
   *  read viewport-dependent fields, they are deliberately defaults. */
  isReady: boolean;

  /** Which surface the provider is currently routing triggers to. */
  surface: AskAISurface;

  /** Whether the desktop sidebar is currently open. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  /** Whether the mobile chat-first modal is currently open. */
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;

  /** Queued prompt that should be auto-submitted as soon as the active
   *  surface is mounted and ready. Consumed by the shell with `take*`. */
  pendingPrompt: string | null;
  /** Queued context (selected text or code snippet) to prepend to the
   *  next user input. Consumed by the shell with `take*`. */
  pendingContext: AskAIContextSnippet | null;

  /** Open the assistant on whichever surface the viewport calls for. */
  open: () => void;
  /** Close every assistant surface. */
  close: () => void;
  /** Toggle the active surface open/closed. */
  toggle: () => void;
  /** Open the assistant and queue `prompt` to be auto-submitted. */
  openWith: (prompt: string) => void;
  /** Open the assistant and queue `snippet` to be prepended to the input. */
  addContext: (snippet: AskAIContextSnippet) => void;

  /** Atomic read+clear for the queued prompt; used by the shell. */
  takePendingPrompt: () => string | null;
  /** Atomic read+clear for the queued context; used by the shell. */
  takePendingContext: () => AskAIContextSnippet | null;
}

const noop = () => {};
const takeNoop = () => null;

const defaultValue: AskAIContextValue = {
  isReady: false,
  surface: 'sidebar',
  sidebarOpen: false,
  setSidebarOpen: noop,
  modalOpen: false,
  setModalOpen: noop,
  pendingPrompt: null,
  pendingContext: null,
  open: noop,
  close: noop,
  toggle: noop,
  openWith: noop,
  addContext: noop,
  takePendingPrompt: takeNoop,
  takePendingContext: takeNoop,
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingContext, setPendingContext] = useState<AskAIContextSnippet | null>(null);

  const surface: AskAISurface = isDesktop ? 'sidebar' : 'modal';

  // Refs let `open`/`close`/`toggle` stay stable across re-renders while
  // still reading the freshest viewport / open-state values. Without
  // this, every viewport resize would invalidate every memoised trigger
  // (which there are many of: header button, bottom bar, hotkey listener,
  // URL handler, code block, text-selection popup).
  const isDesktopRef = useRef(isDesktop);
  const sidebarOpenRef = useRef(sidebarOpen);
  const modalOpenRef = useRef(modalOpen);
  isDesktopRef.current = isDesktop;
  sidebarOpenRef.current = sidebarOpen;
  modalOpenRef.current = modalOpen;

  const open = useCallback(() => {
    if (isDesktopRef.current) setSidebarOpen(true);
    else setModalOpen(true);
  }, []);

  const close = useCallback(() => {
    setSidebarOpen(false);
    setModalOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (isDesktopRef.current) setSidebarOpen((v) => !v);
    else setModalOpen((v) => !v);
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

  const takePendingPrompt = useCallback(() => {
    let value: string | null = null;
    setPendingPrompt((current) => {
      value = current;
      return null;
    });
    return value;
  }, []);

  const takePendingContext = useCallback(() => {
    let value: AskAIContextSnippet | null = null;
    setPendingContext((current) => {
      value = current;
      return null;
    });
    return value;
  }, []);

  // ---------------------------------------------------------------------------
  // Cmd/Ctrl+I global hotkey. Mirrors Mintlify's keyboard shortcut and
  // does not collide with Fumadocs's own Cmd/Ctrl+K (which still opens
  // the search modal via fumadocs-ui's RootProvider).
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

    // Strip the param from the URL bar without triggering a navigation,
    // matching Mintlify's behavior where a deep link does not stick.
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
      sidebarOpen,
      setSidebarOpen,
      modalOpen,
      setModalOpen,
      pendingPrompt,
      pendingContext,
      open,
      close,
      toggle,
      openWith,
      addContext,
      takePendingPrompt,
      takePendingContext,
    }),
    [
      isReady,
      surface,
      sidebarOpen,
      modalOpen,
      pendingPrompt,
      pendingContext,
      open,
      close,
      toggle,
      openWith,
      addContext,
      takePendingPrompt,
      takePendingContext,
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
