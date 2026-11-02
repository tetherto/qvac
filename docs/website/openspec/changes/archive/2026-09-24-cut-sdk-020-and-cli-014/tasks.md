## 1. Lift the cap

- [x] 1.1 Remove the `versions.length > 2` branch from `checkCollection` in `src/lib/version-structure.ts`, leaving every other rejection it performs intact, and drop the comment explaining why a third line was refused.
- [x] 1.2 Rewrite the case in `tests/line-structure.test.ts` that asserts `3 lines declared` and `retire v0.15` so it asserts instead that a three-line collection with one folder group produces no problems.
- [x] 1.3 Update the doc comment on `DocumentedSoftwareKind` in `src/lib/versions.ts`, which describes a collection as publishing "one current line and one older line", to describe it as publishing a current line and every line cut before it.
- [x] 1.4 Run `bun test tests/line-structure.test.ts` and confirm it passes before any folder moves, so the gate is known to accept the shape the next group produces.

## 2. Cut the SDK to 0.20

- [x] 2.1 `git mv "content/docs/sdk/(v0.19)" content/docs/sdk/v0.19`.
- [x] 2.2 Copy `content/docs/sdk/v0.19` to `content/docs/sdk/(v0.20)`, so the new current line starts as exactly what the version-less paths served.
- [x] 2.3 Drop the ` (latest)` suffix from the `title` of `content/docs/sdk/v0.19/reference/api.mdx` and `content/docs/sdk/v0.19/reference/release-notes.mdx`, matching how `v0.18` reads after the previous cut.
- [x] 2.4 In `src/lib/versions.ts`, change the `@qvac/sdk` collection entry's `v0.19` folder from `(v0.19)` to `v0.19` and add `{ version: 'v0.20', folder: '(v0.20)' }` ahead of it, leaving `v0.18` as it is.

## 3. Cut the CLI to 0.14

- [x] 3.1 `git mv "content/docs/cli/(v0.13)" content/docs/cli/v0.13`.
- [x] 3.2 Copy `content/docs/cli/v0.13` to `content/docs/cli/(v0.14)`.
- [x] 3.3 In `src/lib/versions.ts`, change the `@qvac/cli` collection entry's `v0.13` folder from `(v0.13)` to `v0.13` and add `{ version: 'v0.14', folder: '(v0.14)' }` ahead of it, leaving `v0.12` as it is.
- [x] 3.4 Confirm no page under either new line carries its predecessor's version in prose or frontmatter, beyond the two SDK reference titles handled in 2.3.

## 4. Refresh the SDK's derived reference pages

- [x] 4.1 Take the API summary body from `tether/main`, which already carries the `0.20` generator output at `content/docs/reference/api/v0.20.x.mdx`, and write it to `content/docs/sdk/(v0.20)/reference/api.mdx` under this layout's frontmatter. This branch's `packages/sdk` is still at `0.19.1`, so running the generator here would describe the wrong release.
- [x] 4.2 Do the same for the release notes, from `content/docs/reference/release-notes/v0.20.x.mdx`.
- [x] 4.3 Confirm the bodies of the two layouts are byte-identical for a version both carry, so taking `main`'s output is the same content the generator would write, and that both new pages carry `v0.20.x (latest)` while `v0.19` and `v0.18` keep their plain titles.

## 5. Extend the Software Inventory

- [x] 5.1 Add `content/docs/ecosystem/inventory/sdk/v0.20/index.md` as the `@qvac/sdk` README released in `sdk-v0.20.0`, with the same frontmatter and release-link preamble the `v0.19` page uses.
- [x] 5.2 Add `content/docs/ecosystem/inventory/sdk-python/v0.20/index.md` as the `tetherto-qvac-sdk` README released in `sdk-v0.20.0`, since the Python client's version is stamped from the SDK.
- [x] 5.3 Add `content/docs/ecosystem/inventory/cli/v0.14/index.md` as the `@qvac/cli` README released in `cli-v0.14.0`.
- [x] 5.4 Add a row for the new version at the top of the `## Documented versions` table on each of the three package indexes, keeping the existing rows so no inventory URL stops resolving.
- [x] 5.5 Add the three new versions to `src/lib/versions.ts` as the first entry of each package's `versions` array: `v0.20` for `@qvac/sdk` and `tetherto-qvac-sdk`, `v0.14` for `@qvac/cli`.
- [x] 5.6 Confirm every repository-relative link in the three new pages was rewritten to an absolute GitHub URL, as the inventory requires of a README copy.

## 6. Verify

- [x] 6.1 Run `bun test` and confirm the structure check accepts three lines per collection and reports no disagreement between the manifest and the folders.
- [x] 6.2 Run `npm run build` and confirm it completes, which exercises the broken-link check, the redirect replay against both URL fixtures, and the artifact check in one pass.
- [x] 6.3 Confirm the artifact check reports 157 pages — the 111 published today plus the SDK line's 39, the CLI line's 4, and the three inventory version pages — and that each of the six lines has its own corpus and line index, with no cross-line leakage.
- [x] 6.4 Add the index pair for each newly-preserved line, `/sdk/v0.19` and `/cli/v0.13`, beside the pairs `v0.18` and `v0.12` already have, and confirm no page rule was added since neither cut drops a page.
- [x] 6.5 Load `/sdk/` and `/cli/` in the built output and confirm the switcher offers three lines each and that the version-less paths serve `v0.20` and `v0.14`.
- [x] 6.6 Load `/sdk/v0.18/`, `/cli/v0.12/`, `/ecosystem/inventory/sdk/v0.18/`, and `/ecosystem/inventory/cli/v0.12/` and confirm each still resolves, which is the guarantee the lifted cap and the restated inventory floor are there to keep.

## 7. Close out

- [x] 7.1 Run `openspec validate cut-sdk-020-and-cli-014 --strict` and the delta-versus-baseline check, and confirm both pass.
- [x] 7.2 Archive the change with `openspec archive cut-sdk-020-and-cli-014 -y`, then fix the `docs-release-workflow` and `docs-versioning` spec preambles by hand, since archiving rewrites requirements but leaves preambles untouched.
