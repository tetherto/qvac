'use client';

import { Suspense, use, useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

// Mermaid renders lazily on the client (dynamic `import('mermaid')` + an async
// render surfaced through `use()`), so the diagram appears a frame or two after
// the rest of the page. We intentionally do not reserve a height for it: the
// diagram's rendered height depends on its type, content and the viewport
// width, so any fixed placeholder either leaves a permanent gap under short
// diagrams or fails to cover tall ones. Instead we let the content below simply
// shift down when the diagram renders. The `Suspense` boundary still keeps the
// dynamic-import/render suspension local to this component instead of bubbling
// up and blanking a larger region of the page (which would read as flicker).
export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Suspense fallback={null}>
      <MermaidContent chart={chart} />
    </Suspense>
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
    // 'strict' renders the SVG inline and runs it through DOMPurify, encoding
    // any HTML in labels and disabling `click` directives. We do NOT use
    // 'sandbox': that mode wraps the diagram in an `<iframe>` whose height is
    // pinned to the SVG's unscaled `viewBox` height while its width is 100%
    // (see mermaid `putIntoIFrame`), so wide diagrams (e.g. sequence diagrams)
    // scale down to the column width and leave a large empty gap below them.
    // Inlining the SVG lets it size to its rendered height, so no gap. Diagram
    // sources are authored in-repo (trusted), so DOMPurify sanitization is
    // sufficient and the iframe isolation is unnecessary. `click ... "url"`
    // directives stay inert under 'strict' too, so navigation is surfaced as
    // plain Markdown links beside the chart (see ai-capabilities/voice-assistant.mdx).
    securityLevel: 'strict',
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