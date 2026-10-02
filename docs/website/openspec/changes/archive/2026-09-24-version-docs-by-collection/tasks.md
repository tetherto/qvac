## 1. De-risk the routing assumptions

- [x] 1.1 Hand-build one page at `content/docs/sdk/(v0.19)/index.mdx`, export the site, and confirm the folder group is excluded from the slug so the page still resolves at `/sdk/`
- [x] 1.2 Hand-build one page at `content/docs/sdk/v0.18/index.mdx` and record whether the dot-bearing segment survives the build, the `@vahor/next-broken-links` step, and the CDN rules
- [x] 1.3 Add the `200` rewrite for the trailing-slash form and, below it, the `301` from the slash-less form, and confirm both resolve against the built output without looping
- [x] 1.4 Export one line-scoped route handler at `/sdk/v0.18/llms.txt` and confirm it does not collide with the `(docs)/[[...slug]]` catch-all
- [x] 1.5 Navigate client-side into `/sdk/v0.18/` from a version-less page and confirm the `__next.*.txt` payloads resolve through the CDN rules, so the router does not fall back to a document load
- [x] 1.6 Put a `meta.json` in each spike line and confirm `source.pageTree` carries a node per line folder, addressable by its path, whose children reflect that file's order
- [x] 1.7 If the folder group, the segment, the route, the client-side navigation, or the per-line subtree collides irrecoverably, record the change in `design.md` before continuing
- [x] 1.8 Delete the spike content, keeping only the findings

## 2. Phase 1 — Line resolution

- [x] 2.1 Rewrite `src/lib/versions.ts` as the hand-edited manifest: one entry per documented software naming its package and where it is documented, and one entry per line naming its version and its folder, typed so a malformed entry fails the typecheck
- [x] 2.2 Declare the SDK, the Provider, and the four inventory packages in it, with the versions each will publish, and no current version for the inventory packages
- [x] 2.3 Add the resolution over the manifest: a software's published lines, its current line as the entry whose folder is a group, a page's line from its URL, and whether a path belongs to a versioned collection
- [x] 2.4 Generalize `computeSectionVersionUrl` so the current line maps to the version-less path and every other line to its versioned path, preserving the trailing-slash form the Sevalla rules require
- [x] 2.5 Add the line structure check: exactly one folder group per versioned collection, no patch-shaped line name, and no `.mdx` file directly under a versioned collection
- [x] 2.6 Extend that check into the manifest correspondence — every declared line has the folder it names, every line folder is declared, and no entry names a folder that differs from the one on disk — and confirm it reports the offending line by name
- [x] 2.7 Retire `scripts/update-versions-list.ts`, so the file it generated is edited by hand from here on, and remove the generator's note from the file header
- [x] 2.8 Confirm the site still builds with the manifest present and unused by routing

## 3. Phase 1 — Navigation declared per line

- [x] 3.1 Add the two `@icons-pack/react-simple-icons` entries the SDK tree uses to the `icon` resolver in `src/lib/source.ts`, so a `meta.json` can name them
- [x] 3.2 Convert the SDK subtree of `src/lib/custom-tree.ts` into `meta.json` files, one per directory of the line, preserving its current order, separators, titles, and icons
- [x] 3.3 Add the helper that reads a line's subtree out of `source.pageTree` by folder path and returns its children
- [x] 3.4 Replace the SDK's hand-written subtree with one `root: true` folder per line whose children come from that helper, and confirm no page falls outside every root
- [x] 3.5 Keep `collectionTabs` listing exactly four entries, each pointing at its collection's current line, now that a versioned collection contributes more than one root
- [x] 3.6 Replace `archivedVersionsTree`, whose per-line root is what this supersedes
- [x] 3.7 Extend `tests/sidebar-consistency.test.ts` over the composed tree, covering both the declared and the derived parts, and confirm a `meta.json` naming a missing page fails it
- [x] 3.8 Confirm the check no longer treats a page present in one line and absent from another as a failure

## 4. Phase 1 — Cut the SDK's first two lines

- [x] 4.1 Move the sixteen `reference/api/v*.mdx` and `reference/release-notes/v*.mdx` files to `content/_unpublished/`, keeping only both `index.mdx`
- [x] 4.1b Flatten each surviving `index.mdx` up to `reference/api.mdx` and `reference/release-notes.mdx`, so the entry is a page and not a folder holding one, and confirm both URLs are unchanged
- [x] 4.2 `git mv` every SDK page into `content/docs/sdk/v0.18/`, keeping what the site serves today, and confirm no `.mdx` file is left directly under `content/docs/sdk`
- [x] 4.3 Copy `v0.18` to `(v0.19)` verbatim, `meta.json` files included, and confirm the two trees are identical before any release edit
- [x] 4.4 Point the SDK's manifest entries at the folders as cut, then delete one entry and confirm the correspondence check fails before restoring it
- [x] 4.5 Reorder or omit one entry in `(v0.19)`'s `meta.json` and confirm only that line's sidebar changes, then revert it
- [x] 4.6 Replay the pre-versioning URL set and confirm every SDK URL still resolves at its version-less path, without a redirect
- [x] 4.7 Regenerate the `.source/` registry and confirm it lists no path that no longer exists
- [x] 4.8 Point `generate-api-docs.ts` and `generate-release-notes.ts` at the current line's `reference/api.mdx` and `reference/release-notes.mdx`, resolved from the manifest, since the cut removed the folders they wrote into and a page written there would have claimed the current line's URL
- [x] 4.9 Drop the per-series target those two generators took, refusing `--target` rather than ignoring it, and correct the paths `docs-workflow.md` states for the live flow

## 5. Phase 1 — URL continuity

- [x] 5.1 Hand-write the line rules in `public/_redirects` — the `200` rewrite of the trailing-slash form and the `301` from the slash-less form, for the line index alone, which the spike found is the only URL of a line that needs them — plus one redirect per retired archive URL to its current series, the Markdown twins written out individually because a `:version` pattern cannot tell `v0.8.x` from `v0.8.x.md`
- [x] 5.2 Place the block above the terminal `/* /404.html 404` rule, and below the exact rules the file's comment says must precede a `:version` pattern
- [x] 5.3 Capture the pre-versioning URL set as a fixture and extend `scripts/check-redirects.ts` to replay it
- [x] 5.4 Assert that no captured URL needs more than one redirect to reach its page
- [x] 5.5 List any captured URL no rule covers as knowingly dropped, and confirm nothing outside `public/_redirects` was added to keep a URL alive
- [x] 5.6 Write the remark plugin that prefixes a same-collection absolute link with the line of the page carrying it, leaving the current line, unversioned targets, and other collections untouched, and register it in `source.config.ts`
- [x] 5.7 Confirm the plugin's rewrite reaches the per-page Markdown as well as the HTML, by fetching the Markdown of a `v0.18` page and comparing its links to the rendered ones
- [x] 5.8 Teach `tests/link-integrity.test.ts` to resolve a version-less link against the line of the file it appears in, so a link to a page missing from that line fails
- [x] 5.9 Confirm every internal SDK link resolves inside its own line, in both lines, and that no link source text was rewritten by the cut
- [x] 5.10 Run `tests/link-integrity.test.ts` and the build's broken-link step, and fix what they report

## 6. Phase 1 — Human-facing version surfaces

- [x] 6.1 Render `SidebarTabsDropdown` from `fumadocs-ui/components/sidebar/tabs` in the docs layout's `sidebar.banner`, given the active collection's lines, and show it only on a versioned collection
- [x] 6.2 Build each option from the line index — `url` for the destination and `urls` for the line's pathnames, so `isTabActive` resolves the active line — and confirm the browser receives no per-page version data
- [x] 6.3 Derive each option's title from the manifest entry's folder — `v0.19 (latest)` for the group, plain `v0.18` otherwise — so the suffix follows a cut with no edit beyond the entry itself
- [x] 6.4 Point each option at the same path under its line, falling back to that line's index when the page does not exist there
- [x] 6.5 Delete `VersionSelector`, `getVersionSelectorProps`, and the section machinery in `src/lib/versions.ts` that the retired patch-series archives were the only consumer of
- [x] 6.6 Confirm the switch does not reload the document and does not remount the navbar, the collection bar, or the sidebar container
- [x] 6.7 Confirm no switcher appears above the page tree on Platform and Resources
- [x] 6.8 Confirm the narrow-viewport order in the sidebar header — Fumadocs' collection dropdown from `sidebar.tabs`, then the line switcher, then the tree — and that the dropdown still marks the collection active from a page of a non-current line
- [x] 6.9 Set each page's canonical URL to its own line, the version-less path for the current line and the versioned path for the others
- [x] 6.10 Add a switching test asserting that every page of every line lands on its equivalent or on the selected line's index
- [x] 6.11 Add a page to `v0.18` that `(v0.19)` does not carry, list it in that line's `meta.json` only, and confirm it resolves, appears in that line's sidebar and artifacts, and leaves the current line untouched

## 7. Phase 2 — Agent artifacts per line

- [x] 7.1 Remove the "View full docs dump" entry from the page actions popover in `src/components/page-actions.tsx`, and confirm no page control links `llms-full.txt`
- [x] 7.2 Turn the root `llms.txt` into a router naming the collections, which are versioned, and how to choose a corpus
- [x] 7.3 Add the collection-level `llms.txt` resolver listing the lines, marking the current one, and linking each line's file
- [x] 7.4 Add the line-level `llms.txt` and `llms-full.txt` routes, enumerated from the resolved lines and filtered to the line
- [x] 7.5 Declare in the root `llms-full.txt` which line of each versioned collection it contains
- [x] 7.6 Publish `/{collection}/versions.json` from the manifest, naming the tracked package and the current line
- [x] 7.7 Extend the per-page Markdown with build-derived metadata: collection, line, tracked package, whether the line is current, and canonical URL
- [x] 7.8 Add the visible statement of applicability to versioned pages, so the line survives conversion to Markdown
- [x] 7.9 Author the corpus protocol page for coding agents and reference it from the root `llms.txt`
- [x] 7.10 Add the leakage gate: every line has both artifacts, every page has Markdown, no line-scoped artifact references another line of a versioned collection, and published metadata matches the URL
- [x] 7.11 Resolve each artifact URL against the built page set in that same pass, since `@vahor/next-broken-links` reads only HTML and sitemaps and never opens `llms.txt`, `llms-full.txt`, `versions.json`, or the per-page Markdown
- [x] 7.12 Confirm the gate passes an artifact that references unversioned pages and another versioned collection at its version-less path

## 8. Phase 2 — Version-scoped retrieval

- [x] 8.1 Confirm whether the AI Assistant's request path in `src/components/ask-ai/use-ask-ai-chat.tsx` can carry Inkeep attribute filters, and record the finding in `design.md` before building on it
- [x] 8.2 Emit per-page Inkeep attributes for collection, line, and whether the line is current, derived from the route rather than from the URL shape
- [x] 8.3 Pass the attribute filter from the search modal when the reader is inside a line
- [x] 8.4 Pass the same filter from the assistant, or record the limitation and leave it unscoped if its request path cannot carry one
- [x] 8.5 Implement the unscoped-query policy favouring the current line and the unversioned collections, labelling older-line results
- [x] 8.6 Add the metadata-matches-route gate and the cross-line retrieval tests that measure leakage

## 9. Phase 3 — Provider

- [x] 9.1 Move the Provider pages into `content/docs/provider/(v0.13)/`, anchored on `@qvac/cli` `0.13.1`, point its manifest entry at that folder, and confirm no Provider URL changed
- [x] 9.2 Convert the Provider subtree into `meta.json` files inside its line and splice its root through the Phase 1 helper, with no Provider-specific branch
- [x] 9.3 Confirm the single-line state behaves correctly before adding the second: the switcher lists one line, resolution and artifacts work, and nothing assumes a second line exists
- [x] 9.4 Copy `(v0.13)` to `v0.12`, the release before it, declare that entry, and confirm it needs no code change
- [x] 9.5 Note in `v0.12` that it starts as the `0.13` pages, since documentation for `0.12` was never written separately, and correct anything materially wrong for that release
- [x] 9.6 Confirm `v0.12` behaves as any older line does in its URLs, switcher entry, artifacts, and retrieval attributes, and that the switcher labels `(v0.13)` as `v0.13 (latest)`
- [x] 9.7 Extend the redirects, agent artifacts, and retrieval metadata to the Provider with no new infrastructure
- [x] 9.8 Record any change the Provider forced on shared code, since that is the measure of whether the infrastructure was built SDK-shaped

## 10. Phase 4 — Software Inventory

- [x] 10.1 Create the inventory index under `/platform/inventory/`, stating what the inventory documents, how it differs from the product collections, and listing the four packages by published name
- [x] 10.2 Read each package's two most recent released READMEs out of git — `@qvac/sdk` and the Python client from `sdk-v0.19.1` and `sdk-v0.18.2`, `@qvac/ai-sdk-provider` from `ai-sdk-provider-v0.7.0` and `ai-sdk-provider-v0.6.2`, `@qvac/cli` from `cli-v0.13.1` and `cli-v0.12.0` — and paste each into its version folder by hand as `.md`, every version folder plain and none of them a group
- [x] 10.3 Take the SDK's and the Python client's `v0.19` README from `main` if `sdk-v0.19.1` has not been cut when the pages are written, since `main` is what that tag will carry, and record on the page which of the two it came from
- [x] 10.4 Write each package's index at its version-less path: published name, one sentence on what the package is, repository and registry links, and the version list linking each version page and its GitHub release
- [x] 10.5 Add frontmatter to each version page naming the tag it came from, a link to that GitHub release, and a link back to the package index
- [x] 10.6 Point each package's manifest entries at the folders as created, and confirm the correspondence check covers the inventory exactly as it covers the collections
- [x] 10.7 Extend that check so a package index must link exactly the versions the manifest declares, failing on an extra or a missing one
- [x] 10.8 Fix each README's repository-relative links by hand — `../bare-sdk/README.md`, `./docs/serve-openai.md` and the rest — pointing them at GitHub on that version's tag, and leave in-page anchors alone
- [x] 10.9 Confirm all four render, in particular what the Markdown processor does with the SDK's raw HTML banner and the Python client's `<version>` in prose, neither of which MDX would have accepted
- [x] 10.10 Add the `200`/`301` rules covering the inventory's dotted version segments, following the `:version` form, and confirm every version page resolves in both forms
- [x] 10.11 Confirm no line switcher renders on an inventory page, and that the link checks and the leakage gate accept the inventory
- [x] 10.12 Confirm Platform remains unversioned as a collection despite the per-package versions inside it

## 11. Gates

- [x] 11.1 Run the full `build`, including the broken-link step and `scripts/check-redirects.ts`, and confirm it passes
- [x] 11.2 Run every vitest suite and confirm the new structure, switching, leakage, and metadata gates pass
- [x] 11.3 Measure the build after the page count doubles, and record whether the OG image route needs attention
- [x] 11.4 Walk the built site: switch lines within a collection, follow a fallback, cross collections, and confirm the selector label and canonical URL match the line
- [x] 11.5 Watch the network panel across a switch in both directions and confirm no document request, only payload fetches
- [x] 11.6 Confirm every derived surface carries line-scoped URLs and none lists a pre-versioning URL as canonical
- [x] 11.7 Repeat the walk on a narrow viewport, confirming the selector and the collection switcher remain reachable
- [x] 11.8 Perform one cut by hand end to end on a scratch branch — rename the group, copy it forward, update the manifest, adjust the redirects — and confirm the new line's sidebar stands up from the copied `meta.json` files with no edit to `custom-tree.ts`
- [x] 11.9 Record those steps as the procedure a later change can automate
