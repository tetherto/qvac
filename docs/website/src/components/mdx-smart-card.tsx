'use client';

import FumadocsLink from 'fumadocs-core/link';
import { Card as FumaCard } from 'fumadocs-ui/components/card';
import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentProps,
} from 'react';

/**
 * Set to `true` by `SmartCard` while rendering a `Card` that carries
 * its own `href` (i.e. the whole card is already wrapped in an `<a>`).
 * Read by `SmartAnchor` so markdown links inside the card's
 * description fall back to a non-anchor render — preventing the
 * nested-`<a>` hydration error that the browser's parser produces
 * when it tries to recover by auto-closing the outer `<a>`
 * mid-stream.
 *
 * Lives in this `'use client'` module so the React context APIs are
 * legal — the MDX components map in `mdx-components.tsx` is imported
 * from server components and cannot call `createContext` directly.
 */
const InsideCardAnchorContext = createContext(false);

/**
 * Drop-in replacement for Fumadocs's `Card` that exposes "I am an
 * anchor" to its subtree via `InsideCardAnchorContext`. Behaves
 * identically when the card has no `href` (still renders as a plain
 * `div` per Fumadocs's own implementation).
 */
export function SmartCard(props: ComponentProps<typeof FumaCard>) {
  return (
    <InsideCardAnchorContext.Provider value={!!props.href}>
      <FumaCard {...props} />
    </InsideCardAnchorContext.Provider>
  );
}

/**
 * MDX `a:` replacement. When rendered outside a `<Card>` it behaves
 * like the default Fumadocs link; inside a `<Card>` it degrades to a
 * styled `<span>` so we don't emit a nested `<a>` (which the browser
 * parser would auto-close mid-stream, producing a hydration mismatch
 * that bails out the entire page).
 *
 * Takes ONLY serializable props (string `href`, ReactNode children,
 * standard anchor attributes) — never accepts a function as a prop —
 * so it can be rendered from server components without tripping
 * React's "functions cannot be passed to client components" rule.
 *
 * For pages that need relative-path resolution (the
 * `createRelativeLink(source, page)` behavior fumadocs ships), the
 * server-side page wrapper should resolve the href first and then
 * render this component with the resolved string.
 */
export function SmartAnchor(
  props: AnchorHTMLAttributes<HTMLAnchorElement>,
) {
  const insideCardAnchor = useContext(InsideCardAnchorContext);
  if (insideCardAnchor) {
    return (
      <span className="text-fd-primary underline underline-offset-2 decoration-fd-primary/40">
        {props.children}
      </span>
    );
  }
  // Cast to FumadocsLink props - it accepts an `href` and the rest of
  // the standard anchor attributes plus a `prefetch` toggle.
  return <FumadocsLink {...(props as ComponentProps<typeof FumadocsLink>)} />;
}

