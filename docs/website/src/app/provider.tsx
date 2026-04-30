"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const SearchDialog = dynamic(() => import("@/components/inkeep-search")); // lazy load

type NoPrefetchLinkProps = React.ComponentProps<"a"> & { prefetch?: boolean };

function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function NoPrefetchLink({ prefetch: _prefetch, href, onClick, ...props }: NoPrefetchLinkProps) {
  const pathname = usePathname();

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented) return;

    // Prevent same-page navigation on static export. Without this, clicking a
    // sidebar folder whose index URL matches the current page triggers a Next.js
    // soft navigation that refreshes the page and resets sidebar toggle state
    // instead of simply collapsing the folder.
    // Hash/query hrefs won't match the bare pathname, so scroll-to-anchor and
    // parameterized links still work normally.
    if (href && normalize(href) === normalize(pathname)) {
      e.preventDefault();
    }
  }

  return <NextLink href={href ?? "#"} prefetch={false} onClick={handleClick} {...props} />;
}

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      components={{
        Link: NoPrefetchLink,
      }}
      search={{
        SearchDialog,
      }}
    >
      {children}
    </RootProvider>
  );
}
