'use client';

import { Sparkles, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/cn';
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
export function AskAIChatMessage({ message }: { message: ChatMessage }) {
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
        ) : (
          <MarkdownBody content={message.content} />
        )}
      </div>
    </div>
  );
}

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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-fd-primary underline underline-offset-2 hover:text-fd-primary/80"
              {...rest}
            >
              {children}
            </a>
          ),
          code: ({ children, className, ...rest }) => {
            // Inline code: short tokens without a language class.
            // Block code is handled by react-markdown wrapping us in
            // <pre>, which we leave to the global prose styles.
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="rounded bg-fd-muted px-1 py-0.5 font-mono text-[0.85em] text-fd-primary"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...rest }) => (
            <pre
              className="overflow-x-auto rounded-md border bg-fd-muted/40 p-3 font-mono text-xs"
              {...rest}
            >
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
