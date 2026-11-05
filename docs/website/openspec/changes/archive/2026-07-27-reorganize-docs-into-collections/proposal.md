## Why

The documentation site currently covers only the SDK and serves all 69 pages from a single flat tree rooted at `/`, with one hand-maintained sidebar. QVAC now spans several distinct products — the platform itself, the SDK, the provider server, the app, plus research outputs and external resources — and a flat tree cannot express which product a page belongs to or let a reader stay within one product while browsing. Establishing the collection model now, while the content is still small and before per-collection versioning is introduced, avoids repeating a much larger migration later.

## What Changes

- Reorganize `content/docs` so that each top-level folder is a collection, and every page lives inside exactly one collection.
- Introduce four collections in this change: **Platform**, **SDK**, **Provider**, and **Resources**. App and Research are deliberately deferred.
- Add a second-level top navigation bar listing the collections, so readers switch collection from the top of the page rather than from the sidebar.
- Give each collection its own sidebar, hardcoded in the same style as the current single tree, so only the active collection's pages are shown.
- Move the existing pages into the collections. No new pages are authored, with a single declared exception for the Provider collection's overview page, which has no existing counterpart.
- Keep every URL that exists today resolving after the move. Page URLs change because the collection name becomes part of the path, so without redirects this would be **BREAKING** for external deep links, search rankings, and the `llms.txt` surface.

Explicitly out of scope, to be handled by later changes: versioning of any collection (including the versioning that API reference and Release notes have today), the sidebar version switcher, in-content version badges, authoring the pages that the target information architecture anticipates but that do not exist yet, and a standalone sidebar-less home page. The target design has such a home, but this change does not build it: the root redirects into the Platform overview, which is the entry point for now.

## Capabilities

### New Capabilities

- `docs-collections`: the collection model. Which collections exist, the rule that each is a single top-level content folder owning a URL namespace, which existing page belongs to which collection, and the constraint that the reorganization authors no new content.
- `collection-navigation`: how a reader moves between and within collections. The second-level collection bar and the per-collection sidebar showing only the active collection.
- `docs-url-migration`: URL continuity across the move. Every pre-existing URL still resolves, internal links between pages remain valid, and the generated surfaces derived from the page tree stay consistent.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first change in the project.

## Impact

Content:

- `content/docs/**` — every page moves under a collection folder.

Site configuration and navigation:

- `src/lib/custom-tree.ts` — its top level becomes one root folder per collection, wrapping what is there today.
- `src/app/(docs)/layout.tsx` — renders the collection tabs in the navbar.

URL continuity:

- `public/_redirects` — one redirect per moved URL.

Tests and build gates:

- `tests/sidebar-consistency.test.ts` — keeps working unmodified, since it walks the one tree recursively.
- `tests/link-integrity.test.ts` and the `@vahor/next-broken-links` check in `build` — every internal link that points at a moved page must be updated.

Derived surfaces, which regenerate from the page tree and will reflect the new paths:

- `sitemap.xml`, the search index, `llms.txt` and `llms-full.txt`, the per-page `.md` files with their manifest, and OG images.

Scripts that assume content paths:

- The generation and versioning scripts under `scripts/`, plus `src/lib/versions.ts`, which resolve pages by path and must follow the pages they target.
