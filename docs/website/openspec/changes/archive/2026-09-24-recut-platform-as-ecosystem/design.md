## Context

The site publishes four collections, two of them versioned. Platform is unversioned and holds three groups its sidebar keeps apart with separators: an Overview, an "About QVAC" section of three pages, the Software Inventory of four package entries, and the Addons catalogue of eight. The About pages are the only ones that document no distributable.

`how-it-works` is SDK material by its own description — "what happens under the hood when you use QVAC SDK in your application" — and both SDK line overviews already carry a card pointing at it. `vision` and `public-launch` are a manifesto and an October 2025 launch announcement.

Three of the four addresses at stake are live in production, which is the flat tree `docs-production` serves: `/about/how-it-works`, `/about/vision`, and `/about/public-launch`. The `/platform/**` address space exists only on this branch, so the rename itself costs no reader anything, exactly as the CLI rename did.

Two declarations define a collection. `src/lib/custom-tree.ts` holds its name, description, path, and — for an unversioned collection — its sidebar; `src/lib/versions.ts` holds the manifest entries whose paths bind software to a documentation location. Page attributes, retrieval filters, and the agent artifacts all derive from those.

## Goals / Non-Goals

**Goals:**

- Name the collection after what it holds once the About pages leave: everything QVAC publishes, and the add-ons that extend it.
- Put `how-it-works` in the collection whose overviews already link to it.
- Keep every URL production serves resolving, and keep the build's own gates as the proof.
- Keep the retired writing in the repository rather than deleting it.

**Non-Goals:**

- Rewriting `how-it-works`. It moves as it stands; reconciling it against the SDK overview it now sits beside is editorial work for a later change.
- Re-cutting either versioned collection's lines.
- Finding a new home for the vision and launch material. Where that writing belongs — a site section, a blog, the marketing site — is not a documentation decision.
- Renaming the inventory or the add-on pages. Only the collection above them changes.

## Decisions

**The rename is a move, not a label change.** The collection folder becomes `content/docs/ecosystem`, the four inventory manifest paths become `/ecosystem/inventory/**`, and the `/platform/**` addresses stop existing. The path is not decoration: it is the canonical URL, the prefix agents read out of `llms.txt`, the value of the `inkeep:collection` attribute that scopes retrieval, and one of the prefixes the artifact gate scans. This mirrors the CLI rename and is settled by it.

**`how-it-works` goes into both SDK lines.** The line model requires every SDK page to sit inside a line, so the choice is both lines or only the current one. Both, because the page describes the architecture rather than a release: a reader on `v0.18` following the overview's card should land on the page, not a 404. The alternative — current line only — is permitted by the sidebar consistency check, which passes when a page exists in one line and not another, and was rejected because it would make the older line's own card dangle. The page is copied identically into each line; nothing in it is release-specific.

**The retired pages go to `content/_unpublished/`, not to deletion.** That folder already holds the retired patch-series archives, so the convention exists and the build already excludes it. Deleting would lose writing that no one has decided to discard; keeping it published would leave the collection documenting something other than software. `content/_unpublished/ecosystem/about/` records where the pages came from.

**The two retired URLs redirect to the Ecosystem overview rather than 404.** `/about/vision` and `/about/public-launch` are live production URLs. The requirement governing continuity permits a URL to fall through when no rule can express a mapping, but here a rule can: production already answers `/about-qvac/welcome/` and `/about-qvac/flagship-apps/` with a redirect to the collection overview, and these two pages are the same kind of retirement. Sending a reader to the overview of what QVAC publishes is a worse answer than the page they wanted and a much better one than a 404.

**`/platform/**` gets no redirect.** The collections have not shipped to either deployed environment, so no reader has ever been served that address. A rule for it would protect no one and would record, in the file that holds the site's URL history, a move that never happened. This is the rule the CLI rename established and published as a requirement.

**The generated block carries the production URLs, the hand-written block carries the retirements.** `/about/how-it-works`, the eight `/addons/**` pages, the inventory, and the root are all in the move map, so retargeting them is a change to `scripts/collections-move-map.ts` and a regeneration, not a hand edit. Only the two retirement rules are written by hand, beside the section that already documents this kind of rule.

## Risks / Trade-offs

**A reader loses two pages that production serves** → They are redirected to the Ecosystem overview, and the writing stays in the repository. This is the one genuinely breaking part of the change, and it is deliberate: the collection cannot be named after what it holds while it still holds a company manifesto.

**`how-it-works` is duplicated across two lines** → That is what the line model does with every SDK page, and cutting the next line copies the current one wholesale, so the duplication needs no separate upkeep. The risk is the ordinary one of the model, not a new one.

**The older line gains a page it never shipped with** → `v0.18` is a historical line, and adding a page to it is a small rewrite of what that line was. Accepted because the page is not release-specific and because the alternative leaves that line's overview linking at nothing.

**The name "Ecosystem" outlives its accuracy** → If a future collection takes the add-ons or the inventory, the name stops matching again. Mitigated by the same test this change applies: the collection is named after what it holds, so it is renamed when what it holds changes.

## Migration Plan

The change ships with the branch; there is no separate rollout. Rollback is `git revert`, since nothing outside the repository holds state. The only external surface that changes for a reader is the two retirement redirects, and reverting them restores the pages.

## Open Questions

None. The two decisions that were open — which SDK lines receive `how-it-works`, and what the retired URLs answer — are settled above.
