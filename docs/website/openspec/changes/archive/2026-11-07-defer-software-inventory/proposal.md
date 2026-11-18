## Why

The Software Inventory was designed, built, and reviewed alongside the move to documentation lines, and `software-inventory-docs` records the whole of it. Review of the release that introduces it asked for something narrower than the design: ship the ability, not the section. The inventory publishes sixteen pages of package READMEs — a surface with its own editorial obligations, its own release cadence, and its own reviewers — and none of that is settled well enough to go out in the first release of the line model.

Nothing about the inventory has been found wrong. The reason to hold it back is scope, not defect, so deleting it would discard reviewed work for a decision that is expected to be reversed.

There is also nothing to preserve on the way out. The inventory has never been served: no inventory URL appears in `pre-move-urls.json` or `pre-versioning-urls.json`, so unpublishing it breaks no promise and needs no redirect.

## What Changes

- The inventory's pages move to `content/_unpublished/ecosystem/inventory/`, the folder that already holds the retired patch-series archives and the retired Ecosystem pages. The writing is kept, not deleted.
- The manifest lists no package. Every inventory-shaped thing the site builds — the sidebar entries, the version roots, the switcher, the structure checks — is derived from those entries, so emptying them is what unpublishes the section.
- The Ecosystem navigation names the inventory folder only when the manifest lists a package, so an entry never addresses a page the export does not emit.
- `public/_redirects` carries no `:version` rules for the inventory, and records how to write them back.
- The manifest's type is annotated rather than inferred, so which kinds exist stays a property of the vocabulary instead of a property of today's list.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `software-inventory-docs`: gains the requirement that the inventory may be built without being published, and states what publishing it then costs. Every other requirement is untouched and continues to describe the inventory as it will be served.

## Impact

- `docs/website/content/docs/ecosystem/inventory/**` — sixteen pages move to `content/_unpublished/ecosystem/inventory/**`.
- `docs/website/src/lib/versions.ts` — the four `package` entries; the export's type annotation.
- `docs/website/src/lib/custom-tree.ts` — the inventory folder becomes conditional on the manifest.
- `docs/website/public/_redirects` — the eight `:version` rules give way to the note that restores them.
- `docs/website/scripts/check-breadcrumb-row.ts` — the two inventory pages it names.
- `docs/website/README.md` — the paragraph on documenting an inventory release.
- No URL changes: the inventory was never served.
- No test edits. The structure check covers the `package` kind through a synthetic package, so the machinery stays tested; the suites that enumerate the manifest generate no inventory cases while none is listed.
