'use client';

import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';

const MIN_CHARS = 4;
const MAX_CHARS = 4000;

/** CSS selector for containers we treat as docs body content. */
const DOCS_BODY_SELECTOR = 'article, [data-fd-docs-body], .prose';
/** Inputs / chat surfaces we should never hijack the selection inside. */
const IGNORE_SELECTORS = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[data-inkeep-modal]',
  '[data-inkeep-sidebar-chat]',
  'kbd',
  'button',
];

interface PopupState {
  text: string;
  rect: DOMRect;
}

function withinDocsBody(node: Node | null): boolean {
  if (!node) return false;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return false;
  if (!element.closest(DOCS_BODY_SELECTOR)) return false;
  if (element.closest(IGNORE_SELECTORS.join(','))) return false;
  return true;
}

/**
 * Floating "Add to assistant" chip that follows the user's text
 * selection inside the docs body. Mirrors Mintlify's highlight-to-add
 * behavior: when a user selects a snippet of prose / code, a small
 * primary button appears just above the selection rectangle, and
 * clicking it opens the assistant with the selection prepended to the
 * input as context.
 *
 * The popup is intentionally rendered as `position: fixed` rather than
 * via a portal so it inherits the docs theme tokens with no extra setup
 * and stays out of the Inkeep widget's portal tree.
 */
export function AskAITextSelection() {
  const { addContext } = useAskAI();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => setPopup(null), []);

  useEffect(() => {
    function evaluateSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPopup(null);
        return;
      }
      const text = selection.toString().trim();
      if (text.length < MIN_CHARS) {
        setPopup(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!withinDocsBody(range.commonAncestorContainer)) {
        setPopup(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // `getBoundingClientRect()` returns a 0-sized rect when the
      // selection is partially outside the viewport (rare with sticky
      // headers); skip in that case rather than positioning at 0,0.
      if (rect.width === 0 && rect.height === 0) {
        setPopup(null);
        return;
      }
      setPopup({ text: text.slice(0, MAX_CHARS), rect });
    }

    function onSelectionChange() {
      evaluateSelection();
    }

    function onPointerDown(event: PointerEvent) {
      // Don't dismiss when the user clicks the popup itself.
      if (popupRef.current?.contains(event.target as Node)) return;
      // Let the selectionchange handler own dismiss-on-collapse; we
      // only need to short-circuit here to avoid flicker on text drag.
    }

    function onScroll() {
      // Recompute the popup position so it tracks the selection rect.
      evaluateSelection();
    }

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  if (!popup) return null;

  const ESTIMATED_WIDTH = 168;
  const ESTIMATED_HEIGHT = 36;
  const margin = 8;
  const top =
    popup.rect.top - ESTIMATED_HEIGHT - margin > margin
      ? popup.rect.top - ESTIMATED_HEIGHT - margin
      : popup.rect.bottom + margin;
  const rawLeft = popup.rect.left + popup.rect.width / 2 - ESTIMATED_WIDTH / 2;
  const left = Math.max(
    margin,
    Math.min(rawLeft, window.innerWidth - ESTIMATED_WIDTH - margin),
  );

  return (
    <div
      ref={popupRef}
      role="presentation"
      style={{ top, left }}
      className="pointer-events-auto fixed z-40"
    >
      <button
        type="button"
        onClick={() => {
          addContext({
            text: popup.text,
            source: 'selection',
            href: typeof window !== 'undefined' ? window.location.href : undefined,
          });
          // Clear native selection so the popup vanishes after click.
          window.getSelection()?.removeAllRanges();
          dismiss();
        }}
        // The chip floats directly above selected docs prose, so its
        // background MUST stay fully opaque in both default and hover
        // states — otherwise the selection bleeds through and the
        // affordance becomes unreadable. We avoid `bg-fd-accent` on
        // hover because the docs site's `global.css` overrides
        // `--color-fd-accent` with a 0.5-alpha HSLA value, which is
        // exactly what made the previous version translucent. Both
        // `bg-fd-popover` and `bg-fd-secondary` are solid HSL tokens.
        className={cn(
          'inline-flex items-center gap-2 rounded-full border bg-fd-popover px-3 py-1.5 text-xs font-medium text-fd-popover-foreground shadow-lg',
          'hover:bg-fd-secondary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
        )}
      >
        <Sparkles className="size-3.5 text-fd-primary" aria-hidden="true" />
        Add to assistant
      </button>
    </div>
  );
}
