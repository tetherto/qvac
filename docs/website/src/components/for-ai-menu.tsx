'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Plug } from 'lucide-react';
import { MCP_SERVER_URL } from '@/lib/for-ai-menu';

/** The class the framework gives a menu's own entries, worn to match them. */
const ENTRY_CLASS =
  'inline-flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground [&_svg]:size-4';

/** How long the acknowledgement stays up before the entry returns to itself. */
const COPY_RESET_MS = 2000;

/**
 * The For AI menu's MCP entry: copies the server's address, never navigates.
 *
 * The address is an endpoint, not a page. Followed in a browser it yields a
 * stream or an error; what a reader wants is the text, to paste into an
 * agent's configuration. So the entry is a button, and it says when it has
 * copied — a menu entry that did something invisible would leave the reader
 * clicking it again.
 *
 * The framework passes a menu's `custom` child through untouched, so this
 * carries its siblings' classes itself rather than inheriting them.
 */
export function ConnectMcpServer() {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetRef.current) window.clearTimeout(resetRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(MCP_SERVER_URL);
      setCopied(true);
      if (resetRef.current) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => {
        setCopied(false);
        resetRef.current = null;
      }, COPY_RESET_MS);
    } catch {
      // A clipboard the browser refuses is not worth a second failure mode in
      // a menu. The address is also in the page the last entry leads to.
    }
  }

  return (
    <button type="button" onClick={copy} className={ENTRY_CLASS}>
      {copied ? <Check /> : <Plug />}
      {copied ? 'Address copied' : 'Connect the MCP server'}
    </button>
  );
}
