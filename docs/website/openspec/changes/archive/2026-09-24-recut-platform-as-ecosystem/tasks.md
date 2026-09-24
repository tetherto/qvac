## 1. Move the content

- [x] 1.1 Rename `content/docs/platform` to `content/docs/ecosystem` with `git mv`, so the move is recorded as a rename rather than a delete and an add
- [x] 1.2 Move `ecosystem/about/how-it-works.mdx` into the SDK's current line as `sdk/(v0.19)/how-it-works.mdx`, keeping its frontmatter as it stands
- [x] 1.3 Copy the same page into the older line as `sdk/v0.18/how-it-works.mdx`, identical to the current line's copy, since nothing in it is release-specific
- [x] 1.4 Move `ecosystem/about/vision.mdx` and `ecosystem/about/public-launch.mdx` to `content/_unpublished/ecosystem/about/`, and confirm the now-empty `about/` folder is gone
- [x] 1.5 Add `how-it-works` to both SDK lines' `meta.json`, in the Getting started group, and confirm the sidebar consistency check passes for every line

## 2. Rename the collection in the source

- [x] 2.1 In `src/lib/custom-tree.ts`, rename the collection entry to `Ecosystem`, give it a description covering the inventory and the add-ons, and set its path to `/ecosystem`
- [x] 2.2 In the same file, drop the "About QVAC" separator, the How it works entry, and the Vision folder with its Public launch child, leaving Overview, Inventory, and Addons
- [x] 2.3 Retarget the four inventory paths in `src/lib/versions.ts` at `/ecosystem/inventory/**`
- [x] 2.4 Confirm no other module names the collection, since page attributes, retrieval filters, and the artifact gate all derive it from those two declarations

## 3. Repoint the links

- [x] 3.1 Retarget every `/platform` link in the content to `/ecosystem`, in both SDK lines, both CLI lines, the Resources pages, and the inventory itself
- [x] 3.2 Retarget the two SDK overview cards that point at `/platform/about/how-it-works` so each resolves inside its own line
- [x] 3.3 Remove or retarget any link to `/platform/about/vision` and `/platform/about/public-launch`, since both pages leave the published set
- [x] 3.4 Retarget the `/platform` prefix in `src/components/features-infographic.tsx` and any other site source that names it
- [x] 3.5 Run the link integrity test and confirm no internal link targets `/platform`

## 4. Rewrite the redirects

- [x] 4.1 Update `scripts/collections-move-map.ts` so the collection union names `ecosystem`, the former `about/how-it-works` page lands in the SDK's current line, and the index, inventory, and add-on pages land under `/ecosystem`
- [x] 4.2 Regenerate the block and confirm the root, `/about/how-it-works`, and the eight `/addons/**` pages all resolve at their new homes, with their Markdown twins
- [x] 4.3 Add a hand-written `301` from `/about/vision` and `/about/public-launch`, with their Markdown twins, to the Ecosystem overview, beside the section that documents retirement rules
- [x] 4.4 Add no rule for a `/platform/**` address: production has never served it, so a redirect would protect no reader and would record a move that never happened
- [x] 4.5 Confirm the older `/about-qvac/**` rules still land on a page, since two of them point at the pages being retired
- [x] 4.6 Run `scripts/check-redirects.ts` and confirm no rule is shadowed, no rule resolves into `/platform`, and both inventories replay within their redirect budgets

## 5. Update the fixtures and tests

- [x] 5.1 Repoint the `toUrl` values of the index, about, inventory, and add-on entries in `tests/fixtures/collections-move-map.json`
- [x] 5.2 Repoint the `/platform/**` entries of `tests/fixtures/pre-versioning-urls.json` to `/ecosystem/**`, and drop the two retired pages, since that set asserts what resolves without a redirect
- [x] 5.3 Update the collection names and prefixes in `tests/artifact-leakage.test.ts` and `tests/retrieval-filter.test.ts`
- [x] 5.4 Run the test suite and confirm the sidebar consistency, line structure, link integrity, and retrieval filter tests all pass

## 6. Update the prose and close out

- [x] 6.1 Update `AGENTS.md`, `README.md`, and `docs-workflow.md` where they name the collections, so the roster they state is the one the site publishes
- [x] 6.2 Run the full build and confirm every gate passes: no broken links, both URL inventories resolving, and the artifact gate reporting matching metadata with no cross-line leakage
- [x] 6.3 Run `openspec validate --strict`, then check every `MODIFIED` header against `openspec/specs/` and confirm none drops a baseline scenario, because `validate` does not catch that and `archive` refuses it
- [x] 6.4 Archive the change
