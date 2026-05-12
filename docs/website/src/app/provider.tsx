"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const SearchDialog = dynamic(() => import("@/components/inkeep-search")); // lazy load

type DocsLinkProps = React.ComponentProps<"a"> & { prefetch?: boolean };

function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Site-wide override for Fumadocs's `components.Link`.
 *
 * Two behaviours bundled here:
 *
 * 1. Force every link to use Next's default `prefetch="auto"` by stripping
 *    any incoming `prefetch` prop before forwarding to `<NextLink>`. Fumadocs
 *    sidebar items pass `prefetch={true}` (its default), Fumadocs MDX/inline
 *    links pass nothing (`auto`). Mixing those two values for the same href
 *    triggers https://github.com/vercel/next.js/issues/88032 under
 *    `output: 'export'`: the segment cache races and clicks either do nothing
 *    or fall back to a full MPA reload (the original "freezing/reloading"
 *    sidebar bug from January 2026). The maintainer rejected the proposed
 *    upstream fix (https://github.com/vercel/next.js/pull/88114), so the
 *    workaround is to make every link share one consistent prefetch policy.
 *    `auto` is the working code path on static export per
 *    https://github.com/vercel/next.js/issues/92341 — Next consumes the
 *    statically-emitted `__next._tree.txt` / `__next._head.txt` /
 *    `__next.<segment>.txt` payloads on hover/visible.
 *
 * 2. Suppress same-page soft navigation. Without this, clicking a sidebar
 *    folder whose index URL matches the current page triggers a Next.js
 *    soft navigation that refreshes the page and resets sidebar toggle state
 *    instead of simply collapsing the folder (#1220). Hash/query hrefs
 *    don't match the bare pathname, so scroll-to-anchor and parameterized
 *    links still work normally.
 */
function DocsLink({ prefetch: _prefetch, href, onClick, ...props }: DocsLinkProps) {
  const pathname = usePathname();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented) return;

    if (href && normalize(href) === normalize(pathname)) {
      e.preventDefault();
    }
  }

  return <NextLink href={href ?? "#"} onClick={handleClick} {...props} />;
}

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      components={{
        Link: DocsLink,
      }}
      search={{
        SearchDialog,
      }}
    >
      {children}
    </RootProvider>
  );
}
