## 1. De-risk the navigation assumption

- [x] 1.1 Capture the pre-move URL set from the current build (every page URL plus the generated surfaces that list them) into a fixture the redirect check will replay later
- [x] 1.2 Spike `tabMode="navbar"` on the existing notebook `DocsLayout` by temporarily wrapping the current tree's top level in one `root: true` folder, and confirm it renders as a second header row alongside `nav.mode: 'top'`
- [x] 1.3 If the spike does not produce two rows, record the fallback decision in `design.md` before continuing

## 2. Declare the collections as root folders in the one tree

- [x] 2.1 In `src/lib/custom-tree.ts`, wrap the current top-level nodes in four folder nodes carrying `root: true` — Platform, SDK, Provider, Resources — keeping the module exporting a single `customTree`
- [x] 2.2 Give each collection folder the `name` and `description` its tab should show, and an `index` so the tab lands on a chosen page rather than the first one
- [x] 2.3 Keep the current authoring style inside each folder, including `separator` nodes for grouping

## 3. Layout

- [x] 3.1 Add `tabMode="navbar"` to the notebook `DocsLayout` in `src/app/(docs)/layout.tsx`, leaving `sidebar.tabs` unset so the list is derived from the tree's root folders
- [x] 3.2 Keep passing the same single tree, and leave the route structure untouched: no collection route segment and no `generateStaticParams` change
- [x] 3.3 Make the collection entries' hover and active states reuse the sidebar's colour tokens, without redeclaring values for the bar
- [x] 3.4 Keep the first navbar unchanged: logo, search, AI assistant, For AI, main website, and the social and repository links
- [x] 3.5 Verify the site builds, the tabs render, and the sidebar scopes to the active collection while all content is still in its original location

## 4. Move content into collections

- [x] 4.1 Write the move mapping: every existing content path to its collection-scoped destination, as the single source for the moves and the redirects
- [x] 4.2 `git mv` the Platform pages: the site index becomes the collection overview, plus `about/how-it-works.mdx`, `about/vision.mdx`, `about/public-launch.mdx`, and the nine `addons/**` pages nested under the inventory
- [x] 4.3 `git mv` the SDK pages: `introduction.mdx` becomes the overview, plus `quickstart.mdx`, `system-requirements.mdx`, `installation.mdx`, `troubleshooting.mdx`, `cli/index.mdx`, and the `configuration/**`, `models/**`, `ai-capabilities/**`, `p2p-capabilities/**`, `runtime/**`, `tutorials/**`, `reference/api/**`, and `reference/release-notes/**` trees
- [x] 4.4 `git mv` the Provider pages: `cli/http-server/index.mdx`, `cli/http-server/connection.mdx`, and `cli/http-server/integration.mdx`
- [x] 4.5 Fill each collection's root folder as its content lands, and confirm no `.mdx` file is left directly under `content/docs`
- [x] 4.6 Regenerate the `.source/` registry and confirm it lists no path that no longer exists

## 5. The two permitted new pages

- [x] 5.1 Add the Provider collection overview, the only new page in Provider, so the collection has a landing target
- [x] 5.2 Add the Resources collection index as its only page, describing what the collection will index
- [x] 5.3 Confirm no other page was added by diffing the page set against the pre-move fixture

## 6. Path-dependent scripts

- [x] 6.1 Inventory every hardcoded content path in `scripts/` and in `src/lib/versions.ts`, especially the version-archive pages under `reference/`
- [x] 6.2 Update those references to the new locations
- [x] 6.3 Run the documentation generation pipeline and confirm it produces the same set of pages at the new paths

## 7. URL continuity

- [x] 7.1 Generate one `_redirects` entry per moved page from the move mapping, inserted above the terminal `/*  /404.html  404` rule
- [x] 7.2 Add the root entry redirecting `/` to the Platform overview
- [x] 7.3 Add a check that replays the captured pre-move URL set against the built site and fails on any 404
- [x] 7.4 Update every internal link that targets a moved page, so no link depends on a redirect

## 8. Gates

- [x] 8.1 Run `tests/sidebar-consistency.test.ts` and confirm it passes on the tree unchanged, then extend it over the `fallback` tree the archived version pages render
- [x] 8.2 Run `tests/link-integrity.test.ts` and fix every broken internal link it reports
- [x] 8.3 Run the full `build`, including the `@vahor/next-broken-links` step, and confirm it passes
- [x] 8.4 Confirm the generated surfaces carry collection-scoped URLs: sitemap, search index, `llms.txt`, `llms-full.txt`, the per-page Markdown files with their manifest, and the OG images
- [x] 8.5 Walk the built site manually: switch between all four collections, confirm the second header row marks the active collection, confirm the sidebar is scoped to it, and confirm the root lands on the Platform overview
- [x] 8.6 Repeat the walk on a narrow viewport, confirming the collection switcher collapses into a control that lists the same collections and marks the same one active
