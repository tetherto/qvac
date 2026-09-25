'use client';

import { Fragment } from 'react';
import Link from 'fumadocs-core/link';
import { ChevronRight } from 'lucide-react';
import { getBreadcrumbItemsFromPath } from 'fumadocs-core/breadcrumb';
import { useTreeContext, useTreePath } from 'fumadocs-ui/contexts/tree';

/**
 * The trail above a page's heading, naming where the page sits.
 *
 * Replaces the framework's own breadcrumb, which is composed from the same
 * walk and differs only at the two ends. Both of its defaults are wrong here:
 *
 *   - It omits the collection, because a collection is declared as a `root`
 *     folder and `getBreadcrumbItemsFromPath` treats a root as where a trail
 *     starts rather than a step in it. Here the root carries the release the
 *     reader is on — a versioned collection contributes one root per line —
 *     so it is the entry most worth naming, and the one that makes the trail
 *     climb within the reader's own line instead of out of it.
 *   - It omits the page, ending the trail on the page's parent.
 *
 * Turning both on through `DocsPage`'s options gets the entries right and the
 * ends wrong: the page is appended with its URL, so the trail's last item is
 * an anchor to where the reader already is, and a collection's index page
 * ends up naming the collection twice, both times pointing at itself. Neither
 * has an option, so the walk is borrowed and the ends are owned here.
 *
 * The classes are the framework's verbatim, so the trail looks as it did with
 * more entries in it.
 */
function samePage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

export function PageBreadcrumb() {
  const path = useTreePath();
  const { root } = useTreeContext();

  const items = getBreadcrumbItemsFromPath(root, path, {
    includeRoot: true,
    includePage: true,
  });

  // On a collection's index page the walk yields the collection and the page,
  // both addressing the collection. Drop the second: the page is the
  // collection, and what remains is one entry naming where the reader already
  // is, which is a title rather than a path. The two are compared without
  // their trailing slash, because a line's root is declared with one where its
  // version segment carries a dot and the page is not.
  const last = items[items.length - 1];
  const trail =
    items.length > 1 && samePage(last?.url, items[0]?.url)
      ? items.slice(0, -1)
      : items;

  if (trail.length < 2) return null;

  return (
    <div className="flex items-center gap-1.5 text-sm text-fd-muted-foreground">
      {trail.map((item, i) => {
        const isLast = i === trail.length - 1;
        return (
          <Fragment key={i}>
            {i !== 0 && <ChevronRight className="size-3.5 shrink-0" />}
            {isLast || !item.url ? (
              <span className="truncate text-fd-primary font-medium">
                {item.name}
              </span>
            ) : (
              <Link
                href={item.url}
                className="truncate transition-opacity hover:opacity-80"
              >
                {item.name}
              </Link>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
