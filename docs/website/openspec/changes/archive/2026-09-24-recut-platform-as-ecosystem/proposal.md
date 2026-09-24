## Why

The Platform collection holds three unrelated things: an About section about QVAC as a company story, the Software Inventory of published packages, and the add-on catalogue. Only the last two document something the reader can install, and once the About pages leave, what remains is a roster of everything QVAC ships — which is an ecosystem, not a platform.

The About pages are misfiled rather than unwanted. `how-it-works` describes what happens under the hood *when you use the SDK in your application*, which is its own summary, and both SDK line overviews already point at it with a card — it is read as SDK material from a collection that is not the SDK. `vision` and `public-launch` are a manifesto and a launch announcement dated October 2025: audience-facing writing about the company, not documentation of software.

## What Changes

- Rename the `platform` collection to `ecosystem`, so its name states what it holds: the inventory of published packages and the add-ons that extend them.
- Move `how-it-works` into the SDK collection, in both documentation lines, where the page the SDK overviews already link to finally sits beside them.
- Retire `vision` and `public-launch` to `content/_unpublished/`, the same place the patch-series archives went. The writing is kept, not deleted.
- Drop the "About QVAC" section from the collection's navigation. What remains is Overview, Inventory, and Addons.
- **BREAKING** `/about/vision` and `/about/public-launch` stop serving a page. Both are live production URLs, so each redirects to the Ecosystem overview, following the rule production already applies to `/about-qvac/welcome/`.
- `/about/how-it-works` keeps resolving, now into the SDK's current line.
- Every `/platform/**` URL becomes `/ecosystem/**` with no redirect, because the collections have not shipped and no reader has ever been served that address.

## Capabilities

### New Capabilities

None. The change re-cuts an existing collection; every behavior it touches is already specified.

### Modified Capabilities

- `docs-collections`: the collection roster names `ecosystem` rather than `platform`; that collection's composition drops the About pages; the SDK's composition gains `how-it-works` in each line.
- `collection-navigation`: the collection bar lists Ecosystem where it listed Platform, and the collection's sidebar loses its About section.
- `docs-url-migration`: the site root resolves to the Ecosystem overview, and the two retired pages' production URLs redirect there rather than 404.
- `docs-versioning`: the collections that MUST NOT be versioned are Ecosystem and Resources.
- `software-inventory-docs`: the inventory is entered from Ecosystem.
- `versioned-search`: the unversioned-collection scenarios name the collection that exists.
- `versioned-agent-artifacts`: the unversioned-collection scenarios name the collection that exists.
- `version-navigation`: the scenario for a page outside the inventory names the collection that exists.

## Impact

Content moves: `content/docs/platform/**` becomes `content/docs/ecosystem/**`; `about/how-it-works.mdx` becomes a page of each SDK line; `about/vision.mdx` and `about/public-launch.mdx` move to `content/_unpublished/ecosystem/about/`. The `about/` folder ceases to exist.

Code follows the collection's identity from two declarations, as the CLI rename established. `src/lib/custom-tree.ts` holds the collection's name, description, path, and — because Ecosystem is unversioned — its sidebar, which loses the "About QVAC" separator and the Vision folder. `src/lib/versions.ts` holds the four inventory entries whose paths start `/platform/inventory/`. Everything downstream derives from those two.

`public/_redirects` keeps every production URL resolving: the generated block retargets `/about/how-it-works`, `/addons/**`, and the root at their new homes, and two hand-written rules send the retired pages to the Ecosystem overview. No rule is added for `/platform/**`, which production has never served.

Fixtures and tests that name the collection: `tests/fixtures/collections-move-map.json`, `tests/fixtures/pre-versioning-urls.json`, `tests/artifact-leakage.test.ts`, `tests/retrieval-filter.test.ts`, and the collection union in `scripts/collections-move-map.ts`. Internal links: the `/platform` links across both SDK lines, the Resources pages, and the inventory itself, plus the two SDK overview cards that point at `how-it-works`. Prose that names the collection: `AGENTS.md`, `README.md`, and `docs-workflow.md`.
