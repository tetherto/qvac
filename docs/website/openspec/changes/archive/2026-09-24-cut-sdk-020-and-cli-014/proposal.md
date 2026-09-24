## Why

`@qvac/sdk` `0.20.0` and `@qvac/cli` `0.14.0` are released and live, and the site still serves `0.19` and `0.13` at the version-less paths. A reader who lands on `/sdk/` is reading the previous release.

Catching up is the routine move the release workflow already defines — rename the folder group, copy it forward, update the manifest. It cannot run. Both collections already publish two lines, and the baseline refuses a cut that would leave three: the build fails and names the oldest line, because what becomes of it was deliberately left undecided. So the cut is blocked behind a decision, and this change makes it: nothing is retired. A line that has been cut stays published.

## What Changes

- **BREAKING** The cap of two documentation lines per versioned collection is revoked. A versioned collection publishes every line it has cut and keeps it; the build no longer rejects a third. The cost is accepted deliberately: each SDK cut adds 39 pages and each CLI cut adds 4, to the search corpus and the per-line agent artifacts as well as to the page count.
- The SDK is cut to `0.20`. `(v0.19)` becomes `v0.19` and is copied to `(v0.20)`, leaving the collection publishing `v0.20` as current, plus `v0.19` and `v0.18`.
- The CLI is cut to `0.14`. `(v0.13)` becomes `v0.13` and is copied to `(v0.14)`, leaving the collection publishing `v0.14` as current, plus `v0.13` and `v0.12`.
- The version manifest renames two folders and gains two entries, which is what publishes the new lines.
- The SDK's two generated pages — the API summary and the release notes — are regenerated into `(v0.20)`, so the current line's reference material describes `0.20` rather than `0.19`.
- The Software Inventory gains a version page for `@qvac/sdk` `v0.20`, `tetherto-qvac-sdk` `v0.20`, and `@qvac/cli` `v0.14`. No existing version page is removed, so no inventory URL stops resolving.
- `public/_redirects` gains one pair per newly-preserved line — `/sdk/v0.19` and `/cli/v0.13` — because a line index's last segment carries a dot and so misses the CDN's slash normalization. No page rule is added, because neither cut drops a page.

Two things this change does **not** do, each with a consequence worth stating plainly:

- It does not write the prose describing what `0.20` and `0.14` changed. A freshly cut line starts as a copy of its predecessor, which is the defined behaviour, so `(v0.20)` and `(v0.14)` will describe the previous release's surface everywhere except the SDK's two regenerated pages. The new capabilities (TurboVec, MiniMax-H3, Parakeet Nemotron, the TTS and AudioGen surfaces), the new `qvac serve` endpoints, and the breaking changes in the Parakeet language codes and the KV-cache behaviour go undescribed until a follow-up change writes them.
- It does not refresh `@qvac/ai-sdk-provider`, whose `v0.8.0` is released while the inventory carries `v0.7` and `v0.6`. The requirement that each inventory entry carry its two most recent releases therefore stays unmet for that one package after this change ships.

## Capabilities

### New Capabilities

None. This change removes a limit and applies the existing cut procedure; it introduces no behaviour the specs do not already cover.

### Modified Capabilities

- `docs-versioning`: the requirement capping a versioned collection at two lines is revoked and replaced by one stating that every cut line stays published, with the cost named.
- `docs-release-workflow`: the build gate a cut must survive no longer counts lines. The clause rejecting three lines, and the scenario asserting that a third fails the build, are replaced by their inverse.
- `software-inventory-docs`: the coverage requirement is restated so it reads as a floor rather than an exact window — an entry carries at least its two most recent releases and never drops one it has published — which is what keeps `/ecosystem/inventory/sdk/v0.18/` resolving once `v0.20` is added.

## Impact

- **Content.** `content/docs/sdk/(v0.19)` and `content/docs/cli/(v0.13)` are renamed and copied forward, adding 43 pages. Three inventory version pages are added under `content/docs/ecosystem/inventory/`.
- **Manifest.** `src/lib/versions.ts` — two folder renames, two collection entries, three inventory entries.
- **Build gate.** `src/lib/version-structure.ts` — `checkCollection` drops the line-count rejection. Every other check it performs, including the one folder group rule and the patch-shaped name rule, is untouched.
- **Generators.** `scripts/generate-api-docs.ts` and `scripts/generate-release-notes.ts` resolve the current line from the manifest, so they follow the cut with no edit.
- **Derived surfaces.** The switcher, the sidebars, the canonical URLs, the per-line corpora, the line indexes, `versions.json`, and the sitemap are all computed from the manifest and follow by being rebuilt.
- **Tests.** `tests/line-structure.test.ts` asserts the three-line rejection and must assert its removal instead. The URL fixtures replay version-less paths, which keep resolving, so they need no edit.
- **Not affected.** The collection declarations in `src/lib/custom-tree.ts`, and every capability governing URLs, navigation, search scoping, and agent artifacts, all of which read the line set rather than assume its size.
