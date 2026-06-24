'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Sparkles, User } from 'lucide-react';
import {
  isValidElement,
  memo,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/cn';
import { AskAIReferences } from './ask-ai-references';
import { formatCode } from './format-code';
import type { ChatMessage } from './use-ask-ai-chat';

/**
 * A single chat message. User messages render as plain text (we don't
 * want to interpret what the user typed as markdown). Assistant
 * messages render as markdown via `react-markdown` + `remark-gfm` so
 * Inkeep's GitHub-flavored markdown output (links, tables, code
 * fences) lays out correctly.
 *
 * Layout mirrors a typical docs-assistant pattern: a small role
 * indicator on the left, then the message body. The body owns its
 * own max-width so long messages wrap without horizontally
 * stretching the modal.
 */
export const AskAIChatMessage = memo(function AskAIChatMessage({
  message,
  isWaiting = false,
}: {
  message: ChatMessage;
  /**
   * Assistant placeholder is on screen but no tokens have streamed in
   * yet — render the cycling "waiting" indicator instead of the (empty)
   * markdown body.
   */
  isWaiting?: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div
      data-role={message.role}
      className={cn(
        'flex gap-3 px-4 py-3',
        isUser ? 'bg-fd-muted/30' : 'bg-transparent',
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border',
          isUser
            ? 'bg-fd-popover text-fd-muted-foreground'
            : 'bg-fd-primary/10 text-fd-primary',
        )}
      >
        {isUser ? <User className="size-3.5" /> : <Sparkles className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-fd-popover-foreground">
        {isUser ? (
          // Preserve the user's whitespace (including newlines from
          // pasted snippets) without invoking the markdown parser.
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : isWaiting ? (
          <AssistantTypingDots />
        ) : (
          <>
            <MarkdownBody content={message.content} />
            {message.references && message.references.length > 0 ? (
              <AskAIReferences references={message.references} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
});

/**
 * Per-dot animation start offset (ms) for the bouncing typing
 * indicator, so the three dots crest in sequence rather than together.
 */
const TYPING_DOT_DELAYS = [0, 180, 360] as const;

/**
 * Phases the label cycles through while waiting for the first assistant
 * token. Mirrors the three states Inkeep's widget surfaced (Thinking →
 * Looking for content → Analyzing).
 */
const WAITING_LABELS = ['Thinking', 'Looking for content', 'Analyzing'] as const;
const WAITING_LABEL_INTERVAL_MS = 3000;

/**
 * "Waiting" indicator rendered inside the assistant bubble between the
 * user's submission and the first streamed token: a cycling label
 * ("Thinking / Looking for content / Analyzing") followed by three dots
 * that bounce in sequence, like a classic messenger "typing…" bubble.
 * The vertical bounce is driven by the `qvac-typing-dot` keyframe (see
 * global.css); the per-dot stagger comes from an inline `animation-delay`
 * so it never depends on utility ordering. A single `sr-only` label
 * gives screen readers stable feedback without re-announcing each phase.
 */
function AssistantTypingDots() {
  const [labelIndex, setLabelIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setLabelIndex((current) => (current + 1) % WAITING_LABELS.length);
    }, WAITING_LABEL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      role="status"
      className="flex items-baseline gap-2 py-1.5 text-sm text-fd-muted-foreground"
    >
      <span className="sr-only">Generating answer…</span>
      {/* The dots are literal "." glyphs (not CSS circles), so they
          inherit the exact font, size and color of the label — the dot
          size is, by definition, the font's period. They read as a
          spaced "Thinking . . ." (double-space gap from the label and
          between each dot) and bounce on the text baseline. */}
      <span aria-hidden="true" className="inline-flex items-baseline gap-2">
        <span>{WAITING_LABELS[labelIndex]}</span>
        <span className="inline-flex items-baseline gap-2">
          {TYPING_DOT_DELAYS.map((delay) => (
            <span
              key={delay}
              className="qvac-typing-dot inline-block leading-none"
              style={{ animationDelay: `${delay}ms` }}
            >
              .
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

// Hoisted to module scope so their identities are STABLE across every
// render. Passing fresh `components` / `remarkPlugins` on each render
// makes react-markdown treat `<pre>` (etc.) as a brand-new component
// type every keystroke, which unmounts + remounts the `DynamicCodeBlock`
// subtree — re-running Shiki and flashing its placeholder, so the code
// visibly "jumps" while the user types in the composer. Stable
// references let React reconcile the same instances in place.
const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, ...rest }) => {
    // Drop inline source citations. Inkeep injects a citation link (e.g.
    // "(1)") after most sentences; they're redundant with the Sources
    // cards below and far too noisy, so any link whose visible text is
    // just a citation marker ("(1)", "[1]", "1") renders nothing. Genuine
    // links (descriptive text) are unaffected.
    const text = nodeToText(children).trim();
    if (/^\(?\[?\s*\d+\s*\]?\)?$/.test(text)) return null;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-fd-primary underline underline-offset-2 hover:text-fd-primary/80"
        {...rest}
      >
        {children}
      </a>
    );
  },
  // The `code` override is now ONLY ever reached for inline code. Block
  // code is intercepted by the `pre` override below, which reads the
  // fenced `<code>` element's props directly and renders its own markup
  // - so react-markdown never routes the block's inner `<code>` through
  // here. That makes the inline-vs-block split deterministic (remark
  // always wraps block code in `<pre>`; inline code never is) and fixes
  // fences that omit a language.
  code: ({ node: _node, className: _className, children, ...rest }) => (
    <code
      className="rounded bg-fd-muted px-1 py-0.5 font-mono text-[0.85em] text-fd-primary"
      {...rest}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => {
    // `children` is the `<code>` element react-markdown built for the
    // fence. Pull the language (`language-xxx`) and the raw text off it,
    // then hand it to Fumadocs' `DynamicCodeBlock`, which Shiki-
    // highlights at runtime — the SAME renderer the docs pages use, so
    // the tokens get real syntax colors and the indentation is preserved
    // exactly like the rest of the site — and ships a copy button.
    // `not-prose` keeps the global `.prose code` inline-pill styling off
    // the highlighted tokens.
    const codeEl = isValidElement(children)
      ? (children as ReactElement<{
          className?: string;
          children?: ReactNode;
        }>)
      : null;
    if (!codeEl) {
      return (
        <pre className="my-2 overflow-x-auto rounded-md border bg-fd-muted/40 p-3 font-mono text-xs">
          {children}
        </pre>
      );
    }
    const language = /language-(\w+)/.exec(codeEl.props.className ?? '')?.[1];
    const code = nodeToText(codeEl.props.children).replace(/\n$/, '');
    return <ChatCodeBlock language={language} code={code} />;
  },
};

/**
 * Assistant-message markdown renderer. We keep the rule list small
 * and apply targeted Tailwind classes so the output picks up the
 * fumadocs design tokens (`text-fd-primary`, `bg-fd-card`, etc.)
 * without dragging in a full `@tailwindcss/typography` plugin.
 *
 * Streaming-friendly: react-markdown re-parses on every render, but
 * the message body for a single assistant turn is at most a few
 * KB so this is fine for the v1 cost.
 */
function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words text-fd-popover-foreground prose-headings:text-fd-popover-foreground prose-strong:text-fd-popover-foreground prose-code:text-fd-primary">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Flatten an arbitrary React node tree into its plain text. Used to
 * recover the raw source of a fenced code block from the `<code>`
 * element react-markdown hands to our `pre` override, so we can feed
 * it to the copy button verbatim.
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (isValidElement(node)) {
    return nodeToText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * A fenced code block in an assistant message. Shiki-highlighted via
 * Fumadocs' `DynamicCodeBlock` (matching the docs pages), and
 * best-effort re-indented with Prettier first — Inkeep's API collapses
 * code indentation to a single space, so we reconstruct it from the
 * snippet's own syntax. Formatting is async + debounced: the raw text
 * shows immediately (and keeps up while streaming), then snaps to the
 * formatted version once the snippet parses. `not-prose` keeps the
 * global `.prose code` inline-pill styling off the highlighted tokens.
 */
function ChatCodeBlock({ language, code }: { language?: string; code: string }) {
  const [display, setDisplay] = useState(code);

  useEffect(() => {
    // Show the raw (streaming) text right away, then re-indent once the
    // stream settles so Prettier isn't re-run on every streamed token.
    setDisplay(code);
    let cancelled = false;
    const id = window.setTimeout(() => {
      void formatCode(code, language).then((formatted) => {
        if (!cancelled) setDisplay(formatted);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [code, language]);

  return (
    <div className="not-prose my-2">
      <DynamicCodeBlock lang={language ?? 'text'} code={display} />
    </div>
  );
}
