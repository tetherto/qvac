'use client';

import { Suspense, use, useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

// Mermaid renders lazily on the client (dynamic `import('mermaid')` + an async
// render surfaced through `use()`), so without a reserved box the diagram pops
// in a frame or two after the rest of the page and shoves everything below it
// down — a layout shift that reads as the content "flicker" on diagram pages.
// Keep a stable minimum height across the pre-mount, suspended, and rendered
// states; taller diagrams simply grow past it (downward growth from a floor is
// not a shift). Sized to comfortably cover a small flowchart.
const MERMAID_MIN_HEIGHT = 220;

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The reserved box is rendered identically on the server and client so the
  // diagram swaps in without reflowing the surrounding content. The inner
  // `Suspense` keeps the dynamic-import/render suspension local to this box
  // instead of bubbling up and blanking a larger region of the page.
  return (
    <div style={{ minHeight: MERMAID_MIN_HEIGHT }}>
      {mounted ? (
        <Suspense fallback={null}>
          <MermaidContent chart={chart} />
        </Suspense>
      ) : null}
    </div>
  );
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(
  key: string,
  setPromise: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(
    cachePromise('mermaid', () => import('mermaid')),
  );

  mermaid.initialize({
    startOnLoad: false,
    // 'sandbox' renders the diagram inside an `<iframe sandbox="allow-top-
    // navigation-by-user-activation allow-popups">`. Scripts cannot run
    // inside the iframe at all (no `allow-scripts`), so even a malicious
    // diagram (raw HTML / event handler / script tag injected via the
    // classDef bypasses fixed in 11.15.0) cannot reach the parent DOM,
    // cookies, localStorage, or run authenticated requests as the docs
    // origin. Note this also means Mermaid `click ... "url"` directives are
    // inert here — they rely on a JS handler the sandbox blocks — so diagrams
    // must surface navigation as plain Markdown links beside the chart rather
    // than as clickable nodes (see ai-capabilities/voice-assistant.mdx).
    securityLevel: 'sandbox',
    fontFamily: 'inherit',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: resolvedTheme === 'dark' ? 'dark' : 'default',
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () => {
      return mermaid.render(id, chart.replaceAll('\\n', '\n'));
    }),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}