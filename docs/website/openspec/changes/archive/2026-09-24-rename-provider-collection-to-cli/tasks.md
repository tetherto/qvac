## 1. Move the content

- [x] 1.1 Rename `content/docs/provider` to `content/docs/cli` with `git mv`, carrying both line folders, `(v0.13)` and `v0.12`, so the move is recorded as a rename rather than a delete and an add
- [x] 1.2 Replace each line's index with the CLI page: `sdk/(v0.19)/cli.mdx` becomes `cli/(v0.13)/index.mdx` and `sdk/v0.18/cli.mdx` becomes `cli/v0.12/index.mdx`, keeping the page's `ogImage: /og-cli.png` and taking `sidebarTitle: Overview` from the index it replaces
- [x] 1.3 Carry the retired Provider overview's three cards onto each new index, retargeted at `/cli/http-server`, `/cli/http-server/connection`, and `/cli/http-server/integration`, and fold its two sentences about the model provider into the overview's existing HTTP server section
- [x] 1.4 Re-add to `cli/v0.12/index.mdx` the provenance note the retired `v0.12` index carried, stating that the line began as the `0.13` pages because nothing was written separately for `0.12`
- [x] 1.5 Set each line's `meta.json` title to `CLI` with a description naming the tool rather than the provider server, and confirm its `pages` list still reads `["index", "...http-server"]`
- [x] 1.6 Remove `cli` from the `pages` list of both SDK lines' `meta.json`

## 2. Rename the collection in the source

- [x] 2.1 In `src/lib/custom-tree.ts`, rename the collection entry to `CLI`, give it a description covering the whole tool, and set its path to `/cli`
- [x] 2.2 In `src/lib/versions.ts`, point the `@qvac/cli` collection entry at `/cli`, leaving its versions and folders untouched
- [x] 2.3 Confirm no other module names the collection, since page attributes, retrieval filters, the line switcher, and the artifact gate all derive it from those two declarations

## 3. Repoint the links

- [x] 3.1 Retarget every `/provider` link in the content to `/cli`, in both SDK lines, both CLI lines, and the Platform inventory, including the `@qvac/cli` inventory entry's link to its product documentation
- [x] 3.2 Retarget every `/sdk/cli` link in the published content to `/cli`, leaving the unpublished patch-series archives under `content/_unpublished` as they are
- [x] 3.3 Retarget the `/provider` link in `src/components/features-infographic.tsx`
- [x] 3.4 Run the link integrity test and confirm no internal link targets `/provider` or `/sdk/cli`

## 4. Rewrite the redirects

- [x] 4.1 Correct the move map so the CLI pages keep their URLs and regenerate, removing the eight rules that send `/cli`, `/cli/http-server*`, and their Markdown twins out of the address space those pages now occupy again
- [x] 4.2 Add no rule for a `/provider/**` or `/sdk/cli` address: production has never served them, so a redirect would protect no reader and would record a move that never happened
- [x] 4.3 Move the line-index rules for the older line to `/cli/v0.12/`, keeping the `200` rewrite of the trailing-slash form and the `301` from the slash-less form
- [x] 4.4 Confirm against `docs-production` and the `main` staging branch that the retired addresses were never published: both content trees are flat, and both already send `/http-server/` to `/cli/http-server/`
- [x] 4.5 Retarget the pre-collections `/http-server/` rule at `/cli/http-server/`
- [x] 4.6 Run `scripts/check-redirects.ts` and confirm no rule is shadowed, no rule resolves into `/provider`, and both inventories replay within their redirect budgets

## 5. Update the fixtures and tests

- [x] 5.1 Repoint the `toUrl` values of the CLI and HTTP-server entries in `tests/fixtures/collections-move-map.json`, and change the `provider` collection in the union in `scripts/collections-move-map.ts` to `cli`
- [x] 5.2 Repoint the `/provider/**` and `/sdk/cli` entries of `tests/fixtures/pre-versioning-urls.json` to `/cli`, de-duplicating the collision, so the set keeps asserting that the cut into lines costs no URL a redirect
- [x] 5.3 Update the collection names in `tests/artifact-leakage.test.ts` and `tests/retrieval-filter.test.ts`
- [x] 5.4 Run the test suite and confirm the sidebar consistency, line structure, link integrity, and retrieval filter tests all pass

## 6. Update the prose and close out

- [x] 6.1 Update `AGENTS.md` and `docs-workflow.md` where they name the collections, so the roster they state is the one the site publishes
- [x] 6.2 Run the full build and confirm every gate passes: no broken links, both URL inventories resolving, and the artifact gate reporting matching metadata with no cross-line leakage
- [x] 6.3 Run `openspec validate --strict` on this change and on `version-docs-by-collection`, and archive this change only after that one, since its deltas modify requirements that one publishes
