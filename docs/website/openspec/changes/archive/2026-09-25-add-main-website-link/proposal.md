## Why

The docs site is one property of a product published at `qvac.tether.io`, and nothing in its chrome leads back there. A reader who arrives from a search result lands inside the documentation with no route to the product it documents.

The navbar's link bar already carries five destinations — the repository, Discord, Keet, Hugging Face, and X — every one of them a place to find the project rather than the project itself. The one link that would name the product is the one missing.

It is also already promised. `collection-navigation` describes the first navbar as offering "the main website link" among its existing items, in the scenario that fixes what the collection bar sits below. That link has never existed, on this branch or in production, so the scenario asserts something the site does not do.

## What Changes

- Add a sixth entry to the navbar's link bar: a globe leading to `https://qvac.tether.io`, the product's own site.
- Place it first, ahead of the repository entry. The five that follow are places the project can be found; the product's home is a different kind of destination and reads better before them than appended to them.
- Give the navbar's link bar a spec of its own. No capability owns it today: `collection-navigation` mentions it once, only to establish that the collection bar sits below an unchanged navbar. What the bar offers, what belongs in it, and how an entry is declared are now stated somewhere.
- Give the repository and Discord entries an accessible name. The bar is icon-only, so an entry's `label` is the anchor's `aria-label` and the only name a screen reader can read; those two set none, and ship as an unnamed link. The spec this change writes requires one of every entry, so the two that predate it are brought up to it rather than grandfathered into a rule broken on the day it is written.

Not in scope: the "For AI" entry, which the same scenario also names and which also does not exist. It is planned separately, and the new spec is written so it lands as one more entry rather than a rewrite.

## Capabilities

### New Capabilities

- `navbar-links`: the link bar in the top navbar — the destinations it carries, the ordering rule that separates the product's home from the places the project is found, and the accessible name every entry owes a reader who cannot see its glyph.

### Modified Capabilities

None. `collection-navigation`'s scenario is left as written: this change makes its claim about the main website link true, and its claim about the For AI entry becomes the one remaining inaccuracy, to be settled by the change that adds it.

## Impact

- `src/app/(docs)/layout.tsx` — one entry added at the head of the `linkItems` array, one icon import, and a `label` on the two entries that lack one. Nothing else in the layout moves.
- `react-icons/fa6` — already a dependency, already the source of three entries in this bar. No new package.
- No content, no URL, no redirect, and no generated surface is touched. The link is external, so the build's broken-link check does not resolve it.
- The `docs-icons` allowlist does not apply. It governs icons named by a string and resolved through `resolveIcon` for navigation entries; this bar passes components directly, as it already does for every entry it has.
