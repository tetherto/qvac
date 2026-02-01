"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import type { ReactNode } from "react";

const SearchDialog = dynamic(() => import("@/components/inkeep-search")); // lazy load

type NoPrefetchLinkProps = React.ComponentProps<"a"> & { prefetch?: boolean };

function NoPrefetchLink({ prefetch: _prefetch, href, ...props }: NoPrefetchLinkProps) {
  // Work around static-export navigation edge cases by disabling prefetch globally.
  // We still use Next's <Link> so navigation stays client-side and preserves sidebar behavior.
  return <NextLink href={href ?? "#"} prefetch={false} {...props} />;
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
