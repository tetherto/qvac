## Why

The documentation site publishes exactly one version of everything it describes, so a reader on an older release has no correct page to land on and a coding agent has no way to tell which release a page applies to. The only versioning that exists today is section-scoped — the SDK API reference and release notes each keep patch-series archives under `content/docs/sdk/reference/` — which covers two pages out of seventy and cannot express that the provider server ships on its own cadence.

The pressure is immediate: SDK `0.19` ships in about two weeks, and its documentation has to be written against a line that readers on `0.18` are not shown. The collections reorganization deliberately deferred versioning while it partitioned the content; the partition is now in place, and versioning is what it was preparing for.

Versioning the whole site behind a single number would be wrong here: QVAC is several products with independent release lines, and the Platform and Resources collections have nothing to version. The unit of versioning is the collection, not the website.

## What Changes

- Introduce the documentation line as the unit of versioning: one folder per line under its collection, holding an isolated page tree. Patch releases never create a line.
- Declare every documented software and the versions the site publishes for it in one manifest — hand-edited TypeScript constants in `src/lib/versions.ts`, the file that already holds the section-scoped version list and stops being generated here. Publishing a version is two hand edits, the folder and the entry, and the build fails when they disagree. Every version-shaped surface reads the manifest instead of scanning the content tree.
- Version the SDK and the Provider. Leave Platform and Resources unversioned, and let each Resources entry declare its own compatibility.
- Cut the next line as soon as a release is live, so the folder group is always the version shipping next and every edit lands in the folder that will be current when it ships. Because the site deploys with the release, readers only ever see released lines. An older line remains an ordinary content folder, editable like any other.
- Publish two lines per versioned collection:
  - SDK, tracking `@qvac/sdk`: this change ships with `0.19`, so `v0.19` becomes the current line and `v0.18` keeps exactly what the site serves today.
  - Provider, tracking `@qvac/cli`: today's pages become `(v0.13)`, the current release, and are copied back to `v0.12`, the release before it. Both lines are real — `cli-v0.13.1` and `cli-v0.12.0` are published — so the Provider shows the complete model without publishing a version that does not exist. The copy is what the site serves today rather than the 0.8 docs, which were never written; the older line is an ordinary content folder and can be corrected. The anchor is `@qvac/cli` because it implements the OpenAI-compatible HTTP server in `packages/cli/src/serve` — the endpoints, wire formats, streaming, and model discovery that the collection documents. `@qvac/ai-sdk-provider` is a client of that server and appears only on the integration page.
- Keep the current line's URLs exactly as they are, by naming its folder as a Fumadocs folder group — `(v0.19)` — which is excluded from the slug. Only older lines carry a version segment, so `/sdk/js-ts-sdk/` keeps serving the current release while `/sdk/v0.18/js-ts-sdk/` serves the previous one. This generalizes what the API reference and release notes already do, where `index.mdx` is the latest series and `v0.15.x.mdx` is an archive.
- Move a versioned collection's sidebar declaration into its content, as `meta.json` files inside each line's folder, so copying a folder copies the navigation and two lines can order, group, add, or omit entries independently. Platform and Resources keep declaring their trees in `custom-tree.ts`, which also keeps declaring the collections themselves.
- Add a documentation-line switcher at the top of the sidebar, above the navigation tree, built from the section-scoped selector that the page actions strip already carries so it looks and behaves like the controls readers know.
- Resolve the equivalent page across lines by path, and land on the selected line's index when it does not exist.
- Publish agent artifacts per line — `llms.txt`, `llms-full.txt`, per-page Markdown carrying build-derived version metadata — under a hierarchy of root router, collection resolver, and line corpus, plus `versions.json`. No artifact may mix two lines.
- Remove the "View full docs dump" entry from the page actions popover, which opens the root `/llms-full.txt` from any page. A corpus is reached through `llms.txt` for now; exposing the right line's corpus from the page is a later change, and dropping the control removes one surface that would otherwise have to become line-aware.
- Scope Search and the AI Assistant to the reader's line through Inkeep attribute filters, and expose the line as page metadata rather than relying on Inkeep inferring it from the URL, which the current line's unversioned URLs cannot express.
- Reduce the patch-series archives to the current series: keep only the `index.mdx` of the API reference and of the release notes, and move the sixteen `v*.mdx` files to `content/_unpublished/`, redirecting their URLs. Both surfaces belong to the Software Inventory, which this change introduces.
- Document the packages themselves in a Software Inventory under Platform, distinct from the product documentation the collections carry. It starts as the smallest thing that is already true: for `@qvac/sdk`, the Python client, `@qvac/cli`, and `@qvac/ai-sdk-provider`, publish each package's `README.md` as released, in full, as the single page of a version — taken from the release tag by hand, two versions per package where two releases exist, one where only one does. Unlike a product collection, a package is entered at an index that names it and lists its versions, and every README carries a version segment, so no inventory URL changes what it serves when a release happens.
- Define the workflow that cuts the next line right after a release, as a manual procedure the build validates.

Deliberately deferred to later changes, to keep the first implementation small enough to be correct: every form of content automation — a script that cuts a line, one that copies a README out of a tag, one that rewrites link text — plus support statuses beyond "current line and older lines" (`supported`, `maintenance`, `archived`), per-line compatibility manifests declaring exact package releases, declaring a line folder present but unpublished, a page-level control that opens the reader's own line corpus, migrating storage away from duplicated folders, the App and Research collections, and a custom version-aware MCP layer.

Every file move this change needs is performed by hand, and so is every manifest edit: creating a line, declaring it, copying content forward, pasting a README, fixing a link a human wrote. What is built instead is what the static export cannot do without — resolution, routing, per-line navigation, per-line artifacts, and the gates that fail the build when the folders and the published surfaces disagree. A cut is a rename, a copy, and a redirect edit; automating that is worth doing once it has been done by hand more than once, and it is out of scope here.

`tasks.md` sequences the work: SDK for humans, SDK for agents, Provider, then the Software Inventory. Sequencing lives there rather than in separate changes so that one design settles the URL contract, the line rules, and the corpus rules once, and so that the Provider proves the infrastructure is per-collection rather than SDK-shaped.

## Capabilities

### New Capabilities

- `docs-versioning`: the versioning model. Which collections are versioned and against which package, the documentation line as one folder, the manifest that declares every documented software and its lines, the one-to-one correspondence the build enforces between declarations and folders, the rule that the current line is a folder group with no URL segment, the two-line scope, and the rule that lines never carry a patch.
- `versioned-urls`: the URL contract. The current line served at the collection's version-less paths, non-current lines at `/{collection}/v{major}.{minor}/{page}`, canonical resolution, and the trailing-slash treatment that dot-bearing version segments require because the CDN skips normalizing them.
- `version-navigation`: how a reader moves between lines. The switcher at the top of the sidebar, path-based equivalence, the index fallback when the page is absent from the target line, the sidebar scoped to the active line, and the rule that switching is a client-side navigation that leaves the shell standing.
- `versioned-agent-artifacts`: the machine-readable surface. The three-level `llms.txt` hierarchy, per-line `llms-full.txt`, `versions.json`, per-page Markdown carrying build-derived version metadata, and the protocol that tells a coding agent which corpus to use.
- `versioned-search`: version-scoped retrieval. Per-page Inkeep attributes, attribute filters applied to Search and the AI Assistant, the global search policy favouring the current line, and the version scoping of MCP queries.
- `docs-release-workflow`: cutting the next line once a release is live, by hand. Renaming the outgoing folder group, copying it forward, and declaring both in the manifest, the rule that an older line stays editable, the redirects a cut needs for dropped pages, and the build gates that reject a cut done wrong.
- `software-inventory-docs`: the Software Inventory under Platform. Package-level rather than product-level documentation, where a package's version-less path is an index listing the versions the site documents and every README — the newest included — sits at a versioned path, published as released.

### Modified Capabilities

- `docs-collections`: a versioned collection's pages live inside a documentation-line folder rather than directly under the collection, so the composition requirements for SDK and Provider change, and the patch-series archives leave the published set. The constraint that no content may be authored is retired, since it scoped the reorganization and this change both duplicates and authors content by design.
- `collection-navigation`: the sidebar scopes to the active documentation line as well as the active collection, and a versioned collection declares each line's navigation inside that line's own folder, so a cut carries the navigation with the content and the lines are free to differ in structure.
- `docs-url-migration`: URL continuity extends to this move, and is relaxed to what a redirect rule can express — no route, module, or function is added to keep a URL alive, and what no rule covers is allowed to 404 and recorded. The current line keeps every URL published since the reorganization without needing a rule, the retired archive URLs redirect, and an internal link inside a line stays in that line — authored version-less as it is today, and resolved into the reader's line at build, so a cut rewrites no link.

## Impact

Content:

- `content/docs/sdk/**` — every page moves into `v0.18/`, which is then copied to `(v0.19)/` to receive the release's edits.
- `content/docs/provider/**` — every page moves into `(v0.13)/`, which is then copied to `v0.12/` as the previous release's line.
- `content/docs/sdk/reference/api/v*.mdx` and `content/docs/sdk/reference/release-notes/v*.mdx` — sixteen files move to `content/_unpublished/`.
- `content/docs/platform/inventory/**` — new pages, each a README taken by hand from a release tag of `@qvac/sdk`, the Python client, `@qvac/cli`, or `@qvac/ai-sdk-provider`.

Site source:

- `src/lib/versions.ts` — the two-section version list becomes the hand-edited manifest of every documented software and its lines, plus the resolution over it; only `computeSectionVersionUrl` survives, generalized, with its documented Sevalla trailing-slash behaviour unchanged.
- `src/lib/custom-tree.ts` — Platform and Resources stay declared here; SDK and Provider contribute one root folder per line whose children come from that line's own `meta.json` files, replacing `archivedVersionsTree`.
- `content/docs/{sdk,provider}/**/meta.json` — new, one per directory of a versioned collection, carrying the ordering, grouping, titles and icons those subtrees declare in TypeScript today.
- `src/lib/source.ts` — the loader's icon resolver gains the two `@icons-pack/react-simple-icons` entries a `meta.json` now has to name.
- `src/components/page-actions.tsx` — `VersionSelector` is removed, its job taken by the sidebar's own collection control configured over the lines; the "View full docs dump" entry is removed too.
- the docs layout's sidebar — gains the switcher above the navigation tree.
- `src/app/(docs)/[[...slug]]/page.tsx` — canonical URLs, the line badge, and the props the selector consumes.

Generated surfaces:

- `src/app/llms.txt/route.ts`, `src/app/llms-full.txt/route.ts`, `src/app/llm-md-manifest.json/route.ts`, `src/app/sitemap.ts`, `src/app/og/docs/[...slug]/route.tsx`, and `src/app/api/search/route.ts` — all enumerate from the one loader today and must become line-aware.
- `public/_redirects` — the retired archive URLs, plus the dot-segment rules for every non-current line.

Search and assistant:

- `src/components/inkeep-search.tsx` and `src/components/ask-ai/use-ask-ai-chat.tsx` — neither passes retrieval metadata today.

Scripts and gates:

- `scripts/update-versions-list.ts`, `scripts/create-version-bundle.ts`, `scripts/generate-api-docs.ts`, `scripts/generate-release-notes.ts`, and the `release-version-*` orchestrators — they implement the patch-series scheme this change supersedes.
- `tests/sidebar-consistency.test.ts`, `tests/link-integrity.test.ts`, `scripts/check-redirects.ts`, and the `@vahor/next-broken-links` build step — each must cover every line, and new gates are needed for switching and cross-line leakage.
