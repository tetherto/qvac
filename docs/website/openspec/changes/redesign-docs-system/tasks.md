Package scope: only `sdk`, `sdk-python`, `sdk-kotlin`, and `cli` change.

- Their `docs/` folders change freely.
- Their TSDoc may be trimmed.
- Any other source or contract change is marked "review case by case" and waits for the owner's approval.

No other package is touched.

## 1. Foundation: versions files and materialization

- [x] 1.1 Define the versions file schema with zod and add `docs/website/versions/` files for the SDK and the CLI
- [x] 1.2 Derive `src/lib/versions.ts` from the versions files and keep every existing consumer working
- [x] 1.3 Implement `docs:materialize`: `git archive` per pinned line into a `.lines/` snapshot, the documentation root copied to `content/docs/<path>/<folder>/` with the current line as the folder group, materialized folders self-ignored and cleaned when undeclared
- [x] 1.4 Add `--override <software>@<line>=<path|sha>` and `--include-dev` to the materializer
- [x] 1.5 Point fumadocs-mdx and `custom-tree.ts` at the materialized tree, with collection order kept in the site source
- [x] 1.6 Root example imports and example compilation at each line's own folder
- [x] 1.7 Validate the versions files at build: malformed lines, unfetchable commits, pins without documentation, undeclared folders
- [x] 1.8 Implement manual retirement through `retired`, and generate every line's redirect rules from the versions files into `out/_redirects`
- [x] 1.9 Wire `docs:materialize` into `dev`, `build`, and the pull-request checks, and document local use in the README
- [x] 1.10 Extend the line-structure, redirect, and artifact tests to the materialized tree
- [ ] 1.11 Sync the `docs-versioning` and `versioned-urls` deltas into the main specs

## 2. SDK migration and API reference

- [x] 2.1 Move `content/_unpublished/sdk/next/` to `packages/sdk/docs/users/` 
- [x] 2.2 Move the SDK's maintainer documentation from `packages/sdk/docs/` to `packages/sdk/docs/contributors/` and fix links to it
- [x] 2.3 Implement the schema table component: nested, collapsible, to primitives, with the declared-type fallback
- [x] 2.4 Implement the model table component, filtered by capability engines
- [x] 2.5 Derive the client-function map (client function → wire definitions + client-only parameters and returns) in `docs/website` from `contract/manifest.json` and TypeDoc. Any SDK exporter change: review case by case
- [x] 2.6 Implement the language switcher and the per-language signature cards (TypeDoc for JavaScript, griffe for Python)
- [x] 2.7 Add the SDK parity check: every contract method exists in every published language
- [x] 2.8 Replace hand-written facts in the SDK pages with the data components
- [x] 2.9 Replace the Nunjucks API summary with a contract-driven reference, one page per public function, and delete `scripts/api-docs/templates` and the Nunjucks dependency
- [x] 2.10 Render each reference page's Markdown twin as its function's card, publish the `<fn>.schema.json` slice beside it, list both in each line's `llms.txt` and `llms-full.txt`, and carry them through every agent channel (each line's `llms.txt` corpus, the reference pages' Markdown twins, the MCP server), and make the agent protocol page declare the site the reference source
- [x] 2.11 Add the non-failing description report for public request fields in the SDK contract
- [x] 2.12 Trim SDK client TSDoc to summary, deprecation, throws, and status tags
- [ ] 2.13 Pin the SDK's first release after the migration as its first line, and delete `content/docs/sdk/`
- [ ] 2.14 Sync the `docs-collections`, `collection-navigation`, `api-reference`, and `agent-entry-points` deltas into the main specs

## 3. CLI migration

- [x] 3.1 Move `content/_unpublished/cli/next/` to `packages/cli/docs/users/`, and the CLI maintainer documentation to `docs/contributors/`
- [x] 3.2 Add the Commander walker that writes `packages/cli/docs/users/_generated/cli.json`, with a `--check` freshness gate
- [x] 3.3 Implement the CLI command reference component
- [x] 3.4 Export the `qvac serve` OpenAPI document to `_generated/openapi.json` without starting the server, with a `--check` gate, and render its operations with the shared schema table. Any CLI source change: review case by case
- [ ] 3.5 Render the configuration tables from the SDK's configuration schema
- [ ] 3.6 Pin the CLI's first release after the migration as its first line, and delete `content/docs/cli/`
- [x] 3.7 Remove `scripts/cut-line.ts`, `content/_unpublished/`, and every README and `docs-workflow.md` passage on cutting lines

## 4. Docs contract and bindings

- [x] 4.1 Record the editorial contract (page types, the pages a product must provide, per-type scaffolds) as deferred to a follow-up change
- [x] 4.2 Implement symbol identifiers, the projected-surface hash, `api-bindings.lock.json`, and `docs:lock`
- [x] 4.3 Implement the drift check and the product coverage check
- [x] 4.4 Add bindings and locks to the SDK and CLI pages
- [ ] 4.5 Rewrite `qv-docs-update` as package-agnostic and driven by the binding check
- [x] 4.6 Retire `qv-docs-line-cut` and `qv-docs-cutoff`
- [ ] 4.7 Sync the `docs-bindings` delta into the main specs

## 5. CI and release automation

- [ ] 5.1 Extend the docs pull-request checks to `packages/*/docs/users/**`, examples, and generated data, building with overrides
- [ ] 5.2 Add the shared documentation-only classifier with tests for pure and mixed diffs
- [ ] 5.3 Exempt documentation-only pull requests in the release guards, and exclude `packages/*/docs/users/**` from publish triggers
- [ ] 5.4 Add the pin-update workflow for releases and for documentation-only merges into release branches
- [ ] 5.5 Update `docs/gitflow.md`, `docs/ci/RELEASE-TRAIN.md`, and `CONTRIBUTING.md` for documentation in packages and pin-based publication
- [ ] 5.6 Sync the `docs-release-workflow` delta into the main specs

## 6. Ecosystem packages mechanism

- [ ] 6.1 Add the Packages section to Ecosystem, composed from `kind: platform` versions files, with the switcher, and hidden while no package is listed
- [ ] 6.2 Add the TypeDoc normalizer and `docs:api`, which write `_generated/api.json` with a `--check` gate
- [ ] 6.3 Write the software-kind definitions, with a platform package's minimal pages, and a scaffold skill for them
- [ ] 6.4 Implement the contract check of a platform package's minimal pages over a pull request's documentation, and keep it out of the build
- [ ] 6.5 Add a fixture package and tests covering Packages composition, versioning, the switcher, the normalizer, and the contract check
- [x] 6.6 Delete the unpublished Software Inventory pages
- [ ] 6.7 Sync the `docs-contract`, `ecosystem-packages`, and `software-inventory-docs` deltas into the main specs

## 7. Close-out

- [ ] 7.1 Validate every spec with `openspec validate --specs --strict`
- [ ] 7.2 Archive this change
