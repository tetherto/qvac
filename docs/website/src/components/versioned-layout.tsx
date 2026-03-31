'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { Node } from 'fumadocs-core/page-tree';
import { getVersionFromPath } from '@/lib/versions';

/**
 * Client wrapper around DocsLayout that selects the correct sidebar tree
 * based on the current URL version prefix.
 *
 * Trees are resolved server-side and passed as the `versionedTrees` prop.
 * This avoids importing server-only modules (source.ts) into the client bundle.
 */
export function VersionedLayout({
  versionedTrees,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DocsLayout>, 'tree'> & {
  versionedTrees: Record<string, Node[]>;
}) {
  const pathname = usePathname();
  const version = getVersionFromPath(pathname);

  const treeNodes = useMemo(() => {
    if (!version) return versionedTrees['latest'] ?? [];
    return versionedTrees[version] ?? versionedTrees['latest'] ?? [];
  }, [version, versionedTrees]);

  return (
    <DocsLayout
      {...props}
      tree={{ name: 'docs', $id: version ?? 'latest', children: treeNodes }}
    >
      {children}
    </DocsLayout>
  );
}
