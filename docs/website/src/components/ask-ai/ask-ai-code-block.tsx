'use client';

import { Sparkles } from 'lucide-react';
import { type ComponentProps, useRef } from 'react';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';

import { cn } from '@/lib/cn';
import { useAskAI } from './ask-ai-provider';

type PreProps = ComponentProps<'pre'> & {
  /**
   * Shiki / fumadocs-mdx writes the language onto the rendered `<pre>`
   * via this attribute. We surface it as the snippet's `language` so
   * the assistant can use the right Markdown fence in its replies.
   */
  'data-language'?: string;
};

interface AskAITriggerProps {
  className?: string;
  language?: string;
  containerRef: React.RefObject<HTMLElement | null>;
}

function AskAITrigger({ className, language, containerRef }: AskAITriggerProps) {
  const { addContext } = useAskAI();

  function handleClick() {
    const figure = containerRef.current;
    const pre = figure?.getElementsByTagName('pre').item(0);
    if (!pre) return;
    // Match the strategy fumadocs's own copy button uses: clone the
    // element, drop `.nd-copy-ignore` decorations, then read the text.
    // This preserves diff-style highlight prefixes that the user can
    // still see in the rendered code block.
    const clone = pre.cloneNode(true) as HTMLPreElement;
    clone.querySelectorAll('.nd-copy-ignore').forEach((node) => {
      node.replaceWith('\n');
    });
    const text = (clone.textContent ?? '').trim();
    if (!text) return;

    addContext({
      text,
      language,
      source: 'code-block',
      href: typeof window !== 'undefined' ? window.location.href : undefined,
    });
  }

  // Icon-only at every viewport. Keeps the toolbar compact (it sits
  // beside the copy button) and consistent across breakpoints — the
  // sparkles glyph is sufficient affordance once users have seen the
  // assistant's brand mark anywhere else on the site. The accessible
  // name is exposed via `aria-label` for screen readers.
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Ask AI about this code"
      title="Ask AI about this code"
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors',
        'hover:bg-fd-accent hover:text-fd-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
        className,
      )}
    >
      <Sparkles className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * MDX `pre` replacement that mirrors Fumadocs's default behavior
 * (`CodeBlock` + `Pre`) but injects an "Ask AI" trigger alongside the
 * copy button. Clicking it captures the rendered code text + language
 * as context for the next assistant message and opens the assistant
 * surface (sidebar on desktop, full-screen modal on mobile).
 */
export function AskAICodeBlock(props: PreProps) {
  const figureRef = useRef<HTMLElement>(null);
  const language = props['data-language'];

  return (
    <CodeBlock
      {...props}
      ref={figureRef}
      Actions={({ className, children }) => (
        <div className={cn('flex items-center gap-1', className)}>
          <AskAITrigger language={language} containerRef={figureRef} />
          {children}
        </div>
      )}
    >
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}
