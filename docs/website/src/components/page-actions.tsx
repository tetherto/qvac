'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Check,
  ChevronDown,
  Copy,
  ExternalLinkIcon,
  FileText,
  MessageSquare,
  Sparkles,
  Tag,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { buttonVariants } from './ui/button';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover';
import { cva } from 'class-variance-authority';
import type { VersionSelectorProps } from '@/lib/versions';
import { useAskAI } from '@/components/ask-ai';

// Cache fetched Markdown bodies in-memory so repeat clicks on the same page
// reuse a single network round-trip across both "Copy page" and the
// "Copy page as Markdown" dropdown action.
const cache = new Map<string, string>();

const optionVariants = cva(
  'text-sm p-2 rounded-lg inline-flex items-center gap-2 hover:text-fd-accent-foreground hover:bg-fd-accent [&_svg]:size-4',
);

// Canonical Markdown brand mark (https://github.com/dcurtis/markdown-mark).
// Kept inline alongside the OpenAI / Anthropic marks below so every brand
// glyph in this file lives in one place.
function MarkdownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title>Markdown</title>
      <path d="M22.27 19.385H1.73A1.73 1.73 0 0 1 0 17.655V6.345a1.73 1.73 0 0 1 1.73-1.73h20.54A1.73 1.73 0 0 1 24 6.345v11.308a1.73 1.73 0 0 1-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.461v7.846zm15.462-3.923h-2.308V8.077h-2.307V12h-2.308l3.461 4.039z" />
    </svg>
  );
}

type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

const COPY_LABELS: Record<CopyState, string> = {
  idle: 'Copy page',
  copying: 'Copying…',
  copied: 'Copied',
  failed: 'Copy failed',
};

// Time the transient `copied` / `failed` label stays visible before the
// button returns to the idle "Copy page" state.
const COPY_RESET_MS = 2000;

export function CopyPageButton({
  /**
   * URL of the page's raw Markdown file (e.g. `/quickstart.md`). Fetched on
   * click and copied to the clipboard; also opened in a new tab from the
   * "View page as Markdown" dropdown entry.
   */
  markdownUrl,
}: {
  markdownUrl: string;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) window.clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  function scheduleReset() {
    if (resetTimeoutRef.current) window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = window.setTimeout(() => {
      setState('idle');
      resetTimeoutRef.current = null;
    }, COPY_RESET_MS);
  }

  async function copy() {
    setState('copying');
    try {
      let text = cache.get(markdownUrl);
      if (text === undefined) {
        const res = await fetch(markdownUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${markdownUrl}: ${res.status}`);
        text = await res.text();
        cache.set(markdownUrl, text);
      }
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    } finally {
      scheduleReset();
    }
  }

  const label = COPY_LABELS[state];
  const isBusy = state === 'copying';

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        aria-label="Copy page as Markdown"
        disabled={isBusy}
        onClick={copy}
        className={cn(
          buttonVariants({
            color: 'secondary',
            size: 'sm',
            className: 'rounded-r-none border-r-0 gap-1.5 font-normal',
          }),
        )}
      >
        <MarkdownIcon className="size-3.5 text-fd-muted-foreground" />
        <span className="font-normal" aria-live="polite">
          {label}
        </span>
      </button>

      <Popover>
        <PopoverTrigger
          aria-label="Copy page actions"
          className={cn(
            buttonVariants({
              color: 'secondary',
              size: 'sm',
              className: 'rounded-l-none px-2',
            }),
          )}
        >
          <ChevronDown className="size-3.5 text-fd-muted-foreground" />
        </PopoverTrigger>

        <PopoverContent className="flex flex-col">
          <PopoverClose asChild>
            <button
              type="button"
              disabled={isBusy}
              onClick={copy}
              className={cn(optionVariants())}
            >
              <Copy className="text-fd-muted-foreground" />
              Copy page as Markdown
            </button>
          </PopoverClose>

          <PopoverClose asChild>
            <button
              type="button"
              onClick={() => window.open(markdownUrl, '_blank', 'noopener,noreferrer')}
              className={cn(optionVariants())}
            >
              <FileText className="text-fd-muted-foreground" />
              View page as Markdown
              <ExternalLinkIcon className="text-fd-muted-foreground size-3.5 ms-auto" />
            </button>
          </PopoverClose>

          <PopoverClose asChild>
            <button
              type="button"
              onClick={() => window.open('/llms-full.txt', '_blank', 'noopener,noreferrer')}
              className={cn(optionVariants())}
            >
              <FileText className="text-fd-muted-foreground" />
              View full docs dump
              <ExternalLinkIcon className="text-fd-muted-foreground size-3.5 ms-auto" />
            </button>
          </PopoverClose>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function ViewOptions({
  markdownUrl,
}: {
  /**
   * A URL to the raw Markdown/MDX content of page
   */
  markdownUrl: string;
}) {
  const askAI = useAskAI();

  // Seeds the ChatGPT / Claude entries with the page's Markdown URL so the
  // external assistants can read the current page directly. Our in-site
  // assistant uses `askAI.open()` instead and already has the page index,
  // so it does not need the URL seeded into a prompt.
  const fullMarkdownUrl =
    typeof window !== 'undefined' ? new URL(markdownUrl, window.location.origin) : 'loading';
  const q = `Read ${fullMarkdownUrl}, I want to ask questions about it.`;

  const items = useMemo(() => {
    return [
      {
        title: 'Open in ChatGPT',
        href: `https://chatgpt.com/?${new URLSearchParams({
          hints: 'search',
          q,
        })}`,
        icon: (
          <svg
            role="img"
            viewBox="0 0 24 24"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>OpenAI</title>
            <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
          </svg>
        ),
      },
      {
        title: 'Open in Claude',
        href: `https://claude.ai/new?${new URLSearchParams({
          q,
        })}`,
        icon: (
          <svg
            fill="currentColor"
            role="img"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Anthropic</title>
            <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
          </svg>
        ),
      },
    ];
  }, [q]);

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        aria-label="Ask our AI assistant"
        onClick={() => askAI.open()}
        className={cn(
          buttonVariants({
            color: 'secondary',
            size: 'sm',
            className: 'rounded-r-none border-r-0',
          }),
        )}
      >
        <Sparkles className="size-3.5 text-fd-muted-foreground" />
      </button>

      <Popover>
        <PopoverTrigger
          aria-label="Ask AI options"
          className={cn(
            buttonVariants({
              color: 'secondary',
              size: 'sm',
              className: 'rounded-l-none px-2',
            }),
          )}
        >
          <ChevronDown className="size-3.5 text-fd-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="flex flex-col">
          <PopoverClose asChild>
            <button
              type="button"
              onClick={() => askAI.open()}
              className={cn(optionVariants())}
            >
              <MessageSquare className="text-fd-muted-foreground" />
              Ask our AI assistant
            </button>
          </PopoverClose>

          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              rel="noreferrer noopener"
              target="_blank"
              className={cn(optionVariants())}
            >
              {item.icon}
              {item.title}
              <ExternalLinkIcon className="text-fd-muted-foreground size-3.5 ms-auto" />
            </a>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Pure-presentation popover that switches between sibling versioned MDX
 * files. Section detection, version list, current label, and per-version
 * URLs are precomputed at build time by `getVersionSelectorProps()` and
 * passed in as props — the client bundle no longer carries the version
 * manifest or `usePathname()` for this widget. Cross-version navigation
 * goes through `window.location.href` because Fumadocs is statically
 * exported and `router.push` can't soft-navigate to sibling MDX files.
 */
export function VersionSelector({
  versions,
  currentVersion,
  currentLabel,
  versionUrls,
}: VersionSelectorProps) {
  function handleVersionChange(targetVersion: string) {
    if (targetVersion === currentVersion) return;
    const target = versionUrls[targetVersion];
    if (target) window.location.href = target;
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Select version"
        className={cn(
          buttonVariants({
            color: 'secondary',
            size: 'sm',
            className: 'gap-1.5 font-mono',
          }),
        )}
      >
        <Tag className="size-3.5 text-fd-muted-foreground" />
        {currentLabel}
        <ChevronDown className="size-3.5 text-fd-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="flex flex-col">
        {versions.map((version) => (
          <PopoverClose asChild key={version.value}>
            <button
              type="button"
              className={cn(optionVariants())}
              onClick={() => handleVersionChange(version.value)}
            >
              <Check
                className={cn(
                  'text-fd-muted-foreground',
                  currentVersion === version.value ? 'opacity-100' : 'opacity-0',
                )}
              />
              {version.label}
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}
