'use client';

import { SidebarTabsDropdown } from 'fumadocs-ui/components/sidebar/tabs/dropdown';
import { usePathname } from 'fumadocs-core/framework';
import {
  collectionOfPath,
  destinationsFor,
  type CollectionLines,
} from '@/lib/lines';

/**
 * The control that moves a reader between documentation lines.
 *
 * It is the sidebar's own collection control given the lines instead of the
 * collections, so the two read as one mechanism at two scopes and neither
 * carries styling, navigation, or active-state logic of its own. Rendered in
 * the sidebar's `banner` slot, which the notebook layout places after the
 * collection control and before the navigation tree — the switcher belongs to
 * the tree below it, since every entry there changes when the line changes.
 *
 * It serves two scopes with one control: a versioned collection's lines, and
 * an inventory package's versions — which differ only in that the package
 * offers its index alongside them, since no version of a package is served
 * version-less. Nothing renders anywhere else.
 */
export function LineSwitcher({
  collections,
}: {
  collections: CollectionLines[];
}) {
  const pathname = usePathname();
  const collection = collectionOfPath(collections, pathname);
  if (!collection) return null;

  const options = destinationsFor(collection, pathname).map(({ line, url }) => ({
    url,
    title: line.title,
    // What makes the reader's line the selected one: `isTabActive` reads this
    // set before falling back to prefix-matching the option's own URL, which
    // would match every line at once for the page they all share.
    urls: new Set(line.urls),
  }));

  return <SidebarTabsDropdown options={options} />;
}
