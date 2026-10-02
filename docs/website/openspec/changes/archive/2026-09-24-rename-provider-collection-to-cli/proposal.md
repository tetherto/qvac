## Why

The collections split QVAC's documentation by audience: `sdk` for people building applications with QVAC, `provider` for people running it as a local model provider. The cut is defensible as a reading path, but it does not match how the software exists or how it is released. There is no "provider" package: the model provider is `qvac serve`, one feature of `@qvac/cli`, and the CLI also bundles SDK applications, generates configuration, and checks system requirements. The result is that one tool's documentation lives in two collections — the CLI page under `sdk`, the HTTP server under `provider` — versioned against two different packages.

Versioning is what makes this untenable rather than merely untidy. A collection tracks exactly one package and numbers its lines after it, so the CLI page inherits `@qvac/sdk`'s numbers today while documenting a tool released on `@qvac/cli`'s own cadence. A reader on `/sdk/v0.18/cli` is looking at CLI documentation labelled with an SDK release it has no relationship to.

## What Changes

- Rename the `provider` collection to `cli`, tracking the same package it already tracks, `@qvac/cli`. The collection is no longer named after one of the tool's features.
- Move the CLI page out of the SDK collection and into the CLI collection, where it becomes the collection index — restoring the layout the site had before the reorganization, where `cli/index.mdx` and `cli/http-server/**` sat in one folder.
- Retire the Provider overview page. Its three cards move onto the CLI index, and the model provider becomes what it is in the software: the HTTP server section of the CLI documentation.
- Drop the CLI entry from the SDK sidebar. The collection bar already reaches the CLI, and the SDK no longer documents it.
- Every `/provider/**` URL changes to `/cli/**`, in both documentation lines, and `/sdk/cli` moves to `/cli`. Nothing breaks for a reader: neither the collections nor the lines have shipped, so those addresses have never been served and the rename adds no redirect for them.
- Four URLs the reorganization was going to take away keep their meaning instead: `/cli`, `/cli/http-server`, `/cli/http-server/connection`, and `/cli/http-server/integration` are what production serves today, and the rename returns pages to them rather than redirecting them into another collection.

The CLI page moves as it stands. Reconciling its HTTP server summary against the HTTP server pages it now sits beside is editorial work this change does not do.

## Capabilities

### New Capabilities

None. The change re-draws a collection boundary; every behavior it touches is already specified.

### Modified Capabilities

- `docs-collections`: the collection roster names `cli` rather than `provider`; the CLI collection's composition covers the whole tool, including the page the SDK gives up; the SDK's composition no longer includes it.
- `collection-navigation`: the collection bar lists CLI where it listed Provider.
- `docs-versioning`: the versioned collections are the SDK and the CLI, and the collection whose lines follow `@qvac/cli` is the one named after it.
- `docs-url-migration`: the reclaiming of the `/cli/**` addresses the reorganization redirects away, and the rule that an address the site never served earns no redirect.
- `versioned-search`: the cross-collection retrieval scenario names the collection that exists.
- `versioned-agent-artifacts`: the cross-collection reference scenario names the collection that exists.

## Impact

Content moves: `content/docs/provider/**` becomes `content/docs/cli/**` in both lines, `(v0.13)` and `v0.12`; `content/docs/sdk/(v0.19)/cli.mdx` and `content/docs/sdk/v0.18/cli.mdx` become the CLI lines' `index.mdx`; the Provider overview pages are retired.

Code follows the collection's identity from two declarations. `src/lib/custom-tree.ts` holds the collection's name, description, and path, and `src/lib/versions.ts` holds the manifest entry whose path binds the lines to the collection. Everything downstream — the sidebar, the line switcher, page attributes, retrieval filters, agent artifacts — derives from those two, so no further module needs editing.

`public/_redirects` loses rules rather than gaining them. The six sending `/cli/http-server*` and its Markdown twins to `/provider` would become loops the moment those addresses are pages again, and the two sending `/cli` to `/sdk/cli` go the same way; all eight are generated, so they disappear once the move map says the CLI pages keep their URLs. No rule is added for `/provider/**` or `/sdk/cli`, because production has never served either. The line-index rules for the older line move to `/cli/v0.12`, and the pre-collections `/http-server/` rule returns to the target production already gives it.

Fixtures and tests that name the collection: `tests/fixtures/collections-move-map.json`, `tests/fixtures/pre-versioning-urls.json`, `tests/artifact-leakage.test.ts`, `tests/retrieval-filter.test.ts`, and the collection union in `scripts/collections-move-map.ts`. Internal links: thirteen `/provider` links across the SDK lines, the inventory, and `src/components/features-infographic.tsx`, plus the inventory's CLI entry, which links to the collection as the package's product documentation. Prose that names the collection: `AGENTS.md` and `docs-workflow.md`.

This change depends on `version-docs-by-collection` and MUST be archived after it. Its deltas modify requirements that change publishes, including the Provider collection's lines and the composition rules that put every page of a versioned collection inside a line.
