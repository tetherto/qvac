## Why

A page deep in a collection does not say where it sits. `/sdk/configuration/plugins/write-custom-plugin` renders a trail reading `Configuration › Plugin system` — the folders between the collection and the page, and nothing else. The collection is missing from the top and the page is missing from the bottom, so the trail names only the middle of the path and never its endpoints.

The collection is absent because it is the tree's `root` node, and Fumadocs treats a root as the point a trail starts from rather than a step in it. That is the right default for a layout where the root is implicit, and the wrong one here: this site publishes a versioned collection as one root per documentation line, so the root carries the release the reader is on. A trail that omits it omits the one fact the reader most needs to climb back to.

The page is absent because Fumadocs omits the current page by default. The result is a trail that ends on the page's parent, leaving the reader to infer the last step from the heading below it.

## What Changes

- Every documentation page carries a trail naming the collection, every ancestor folder that has a page, and the page itself.
- For a page of an older documentation line, the collection entry leads to that line's index rather than the current release's, so climbing out of a page never silently changes which release the reader is reading.
- The last entry names the current page and is not a link, so the trail offers no navigation to where the reader already is.
- A collection's own index page carries no trail, since a trail there would name the collection twice and lead nowhere.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `collection-navigation`: gains the trail as a third way a reader moves within a collection, beside the collection bar and the sidebar. Its existing requirements are unchanged.

## Impact

- `src/app/(docs)/[[...slug]]/page.tsx` — passes a breadcrumb slot to `DocsPage` in place of the default one.
- A new component holding that slot, composing the trail from the same page tree the sidebar is built from.
- `tests/` — a test asserting the trail's shape against the built pages, since the rules that shape it are Fumadocs' and can change under an upgrade.
- No content changes, no URL changes, no change to the sidebar, the collection bar, or the line switcher.
