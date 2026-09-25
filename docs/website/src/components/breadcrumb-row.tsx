'use client';

import { Fragment } from 'react';
import Link from 'fumadocs-core/link';
import { ChevronRight } from 'lucide-react';
import { usePathname } from 'fumadocs-core/framework';
import { getBreadcrumbItemsFromPath } from 'fumadocs-core/breadcrumb';
import { useTreeContext, useTreePath } from 'fumadocs-ui/contexts/tree';
import { pageAttributes } from '@/lib/page-attributes';

type TrailItem = ReturnType<typeof getBreadcrumbItemsFromPath>[number];

/**
 * The row above a page's heading: where the page sits, and which release it
 * documents.
 *
 * It replaces the framework's breadcrumb, which is the only slot on this row,
 * because the release label has to appear on pages that render no trail — a
 * collection index and a line index both do — so the label cannot hang off
 * the trail's own rendering. Where neither has anything to say, which is the
 * index page of a collection publishing no lines, there is no row at all.
 */
export function BreadcrumbRow() {
  const pathname = usePathname();
  const trail = useTrail();
  const { line, currentLine } = pageAttributes(pathname);

  if (trail === null && !line) return null;

  return (
    <div className="flex items-center gap-4">
      {trail && <Trail items={trail} />}
      {line && <ReleaseLabel line={line} current={currentLine === true} />}
    </div>
  );
}

/**
 * The release the page documents.
 *
 * The brand colour marks the current line and a neutral one marks every past
 * line, which is the whole visual distinction. Colour cannot carry it alone —
 * `v0.18` does not say it is out of date — so the standing follows as hidden
 * text. That is what a screen reader announces, and what anything keeping
 * only the page's text is left with.
 *
 * A statement, not a control: changing line belongs to the switcher above the
 * sidebar, which also handles the case a link here would not, a page the
 * target line does not have.
 */
function ReleaseLabel({ line, current }: { line: string; current: boolean }) {
  return (
    <span
      className={`ms-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
        current
          ? 'bg-fd-primary/10 text-fd-primary'
          : 'bg-fd-muted text-fd-muted-foreground'
      }`}
    >
      {line}
      <span className="sr-only">
        {current ? ', the current release' : ', not the current release'}
      </span>
    </span>
  );
}

function Trail({ items }: { items: TrailItem[] }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-fd-muted-foreground">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
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

/**
 * The page's position, or nothing where a trail would name only the page the
 * reader is already on.
 *
 * Composed from the framework's own path walk, whose two defaults are both
 * wrong here:
 *
 *   - It omits the collection, because a collection is declared as a `root`
 *     folder and `getBreadcrumbItemsFromPath` treats a root as where a trail
 *     starts rather than a step in it. Here the root carries the release the
 *     reader is on — a versioned collection contributes one root per line —
 *     so it is the entry most worth naming, and the one that makes the trail
 *     climb within the reader's own line instead of out of it.
 *   - It omits the page, ending the trail on the page's parent.
 *
 * Turning both on gets the entries right and the ends wrong: the page is
 * appended with its URL, so the trail's last item is an anchor to where the
 * reader already is, and a collection's index page ends up naming the
 * collection twice, both times pointing at itself. Neither has an option, so
 * the walk is borrowed and the ends are owned here.
 */
function useTrail(): TrailItem[] | null {
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

  return trail.length < 2 ? null : trail;
}

function samePage(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}
