## 1. Build the slot

- [x] 1.1 Add a breadcrumb component beside the site's other docs components, composing the trail from `getBreadcrumbItemsFromPath` with the root and the page both included.
- [x] 1.2 Drop the page entry when its URL equals the root's, which is the collection-index case, and return nothing when fewer than two entries remain.
- [x] 1.3 Render every entry but the last as a link, and the last as text.
- [x] 1.4 Carry the classes the framework's default breadcrumb uses, so the trail looks as it does today.

## 2. Put it in the page

- [x] 2.1 Pass the component to `DocsPage` as its breadcrumb slot in `src/app/(docs)/[[...slug]]/page.tsx`, replacing the experimental `breadcrumb` options currently on it.

## 3. Guard it

- [x] 3.1 Add a check asserting the trail against the built HTML: the collection leads the trail and links its own line's index, the page closes it without a link, ancestors link their pages, and a collection index has no trail. Place it where the site's other built-output assertions live.
- [x] 3.2 Confirm the check fails when the collection entry is removed from a built trail, and when the last entry is given a link.

## 4. Verify

- [x] 4.1 Run `npm test` and confirm the suite passes.
- [x] 4.2 Run `npm run build` and confirm it passes, with every existing check clean.
- [x] 4.3 Read the built trails across all four collections, at one, two, and three levels deep.
- [x] 4.4 Confirm a page of a past documentation line climbs to that line's index and not to the current one.
- [x] 4.5 Confirm no collection index and no line index renders a trail.

## 5. Land it

- [x] 5.1 Validate the change with `openspec validate add-page-breadcrumb --strict` and archive it.
- [x] 5.2 Check the published `collection-navigation` spec after archiving.
- [x] 5.3 Commit the whole change as one commit.
