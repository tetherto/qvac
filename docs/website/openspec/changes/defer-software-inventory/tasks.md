## 1. Withdraw the pages without discarding them

- [x] 1.1 Move `content/docs/ecosystem/inventory/` to `content/_unpublished/ecosystem/inventory/`, the folder the retired patch-series archives and Ecosystem pages already use.
- [x] 1.2 Confirm the move is a rename in the diff, so the writing stays reviewable and the history follows it.
- [x] 1.3 Confirm no inventory URL appears in `tests/fixtures/pre-move-urls.json` or `pre-versioning-urls.json`, so nothing needs a redirect out.

## 2. Empty the manifest of packages

- [x] 2.1 Remove the four `package` entries from `DOCUMENTED_SOFTWARE`, leaving the `package` kind, its types, and every helper in place.
- [x] 2.2 Annotate the export as `readonly DocumentedSoftware[]` instead of inferring it, so a list holding one kind does not narrow `kind` to it and make every test of the other a type error.
- [x] 2.3 Rewrite the manifest's header and the comment above the list to say the inventory is built and unpublished, and what publishing it costs.

## 3. Leave nothing dangling

- [x] 3.1 Name the inventory folder in Ecosystem only when the manifest lists a package, so its index never addresses a page the export does not emit.
- [x] 3.2 Replace the eight `:version` rules in `public/_redirects` with the note that says how to write them back.
- [x] 3.3 Drop the two inventory pages `check-breadcrumb-row.ts` names, and say in its comment why an inventory version belongs there when one exists.
- [x] 3.4 Rewrite the README's inventory paragraph: where the pages are, what publishing them takes, and what documenting a release looks like once they are published.

## 4. Prove it

- [x] 4.1 Typecheck clean.
- [x] 4.2 Build clean, with the page count down by exactly the sixteen inventory pages and every pre-move and pre-versioning URL still resolving.
- [x] 4.3 Suite green, with the structure check still covering the `package` kind through its synthetic package.
