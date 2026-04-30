'use client';

import * as React from 'react';
import { Copy } from 'lucide-react';

export function CopyInline({
  textToCopy,
  children,
}: {
  textToCopy: string;
  children: React.ReactNode;
}) {
  const [toast, setToast] = React.useState<string | null>(null);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="inline cursor-pointer text-left text-foreground hover:opacity-80"
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();

          await navigator.clipboard.writeText(textToCopy);

          setToast(`Copied to clipboard: ${textToCopy}`);
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setToast(null), 2200);
        }}
        aria-label="Copy"
        title="Copy"
      >
        <span className="inline">{children}</span>{' '}
        <Copy className="inline h-4 w-4 align-text-bottom" />
      </button>

      {toast && (
        <span
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-0 top-full mt-2 max-w-[min(70vw,36rem)] rounded-md border border-border px-2 py-1 text-xs text-foreground shadow-lg whitespace-normal break-words [overflow-wrap:anywhere]"
          style={{
            backgroundColor: 'rgb(from var(--color-fd-background) r g b / 1)',
            backdropFilter: 'none',
            opacity: 1,
          }}
        >
          {toast}
        </span>
      )}
    </span>
  );
}

