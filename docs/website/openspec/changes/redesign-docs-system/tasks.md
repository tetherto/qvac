## 1. Proof of concept (local branch, not merged)

- [ ] 1.1 Create a local branch with two commits carrying `docs/users/` for the SDK, each with a different version of one example
- [ ] 1.2 Write a throwaway versions file and materializer that pin two SDK lines to those commits, and show each line rendering its own example
- [ ] 1.3 Render the SDK Translation page with a schema table from `contract/schema.json` and a model table from `contract/models.json`
- [ ] 1.4 Add the JavaScript/Python field-name switcher to the schema table
- [ ] 1.5 Render one CLI command reference from the Commander tree and the `qvac serve` OpenAPI page with `fumadocs-openapi`
- [ ] 1.6 Render `translation-nmtcpp` and `llm-llamacpp` under Ecosystem → Packages from TypeDoc over their `index.d.ts`
- [ ] 1.7 Show a binding check that fails on a changed contract definition and passes after the lock is updated
- [ ] 1.8 Record what the proof of concept changed in this design through an update of this change

## 2. Foundation: versions files and materialization

- [ ] 2.1 Define the versions file schema with zod and add `docs/website/versions/` files for the SDK and the CLI
- [ ] 2.2 Derive `src/lib/versions.ts` from the versions files and keep every existing consumer working
- [ ] 2.3 Implement `docs:materialize`: `git archive` per pinned line into `.content/`, the current line written as the folder group, and `.content/` gitignored
- [ ] 2.4 Add `--override <software>@<line>=<path|sha>` and `--include-dev` to the materializer
- [ ] 2.5 Point fumadocs-mdx and `custom-tree.ts` at the materialized tree, with collection order kept in the site source
- [ ] 2.6 Root example imports and example compilation at each line's own folder
- [ ] 2.7 Validate the versions files at build: malformed lines, unfetchable commits, pins without documentation, undeclared folders
- [ ] 2.8 Implement `retain` and `retired`, generating a redirect from each retired line's paths to the current line
- [ ] 2.9 Wire `docs:materialize` into `dev`, `build`, and the pull-request checks, and document local use in the README
- [ ] 2.10 Extend the line-structure, redirect, and artifact tests to the materialized tree
- [ ] 2.11 Sync the `docs-versioning` and `versioned-urls` deltas into the main specs

## 3. SDK migration and API reference

- [ ] 3.1 Move `content/_unpublished/sdk/next/` to `packages/sdk/docs/users/` and set `kind: entry-point` in its root `meta.json`
- [ ] 3.2 Move the SDK's maintainer documentation from `packages/sdk/docs/` to `packages/sdk/docs/contributors/` and fix links to it
- [ ] 3.3 Implement the schema table component: nested, collapsible, to primitives, with the declared-type fallback
- [ ] 3.4 Implement the model table component, filtered by capability engines
- [ ] 3.5 Extend the SDK contract exporter with a client-function map: client function → wire definitions + client-only parameters and returns
- [ ] 3.6 Implement the language switcher and the per-language signature cards (TypeDoc for JavaScript, griffe for Python)
- [ ] 3.7 Add the SDK parity check: every contract method exists in every published language
- [ ] 3.8 Replace hand-written facts in the SDK pages with the data components
- [ ] 3.9 Replace the Nunjucks API summary with a contract-driven reference and delete `scripts/api-docs/templates` and the Nunjucks dependency
- [ ] 3.10 Add the per-function agent cards and the per-method schema slices to each line's corpus
- [ ] 3.11 Add the description check for public request fields, and complete the missing Zod descriptions in `packages/inference`
- [ ] 3.12 Trim SDK client TSDoc to summary, deprecation, throws, and status tags, as agreed with the SDK team
- [ ] 3.13 Pin the SDK's first release after the migration as its first line, and delete `content/docs/sdk/`
- [ ] 3.14 Sync the `docs-collections`, `collection-navigation`, and `api-reference` deltas into the main specs

## 4. CLI migration

- [ ] 4.1 Move `content/_unpublished/cli/next/` to `packages/cli/docs/users/`, and the CLI maintainer documentation to `docs/contributors/`
- [ ] 4.2 Add the Commander walker that writes `_generated/cli.json`, with a `--check` freshness gate
- [ ] 4.3 Implement the CLI command reference component
- [ ] 4.4 Export the `qvac serve` OpenAPI document to `_generated/openapi.json` without starting the server, with a `--check` gate, and render it with `fumadocs-openapi`
- [ ] 4.5 Render the configuration tables from the SDK's configuration schema
- [ ] 4.6 Pin the CLI's first release after the migration as its first line, and delete `content/docs/cli/`
- [ ] 4.7 Remove `scripts/cut-line.ts`, `content/_unpublished/`, and every README and `docs-workflow.md` passage on cutting lines

## 5. Docs contract and bindings

- [ ] 5.1 Agree the prose elements of each page type with the documentation owner, and update this change with them
- [ ] 5.2 Write the software-kind and page-type definitions and the page scaffolds
- [ ] 5.3 Implement the contract check over a pull request's authored documentation, and keep it out of the build
- [ ] 5.4 Implement symbol identifiers, the projected-surface hash, `api-bindings.lock.json`, and `docs:lock`
- [ ] 5.5 Implement the drift check and the entry-point coverage check
- [ ] 5.6 Add bindings and locks to the SDK and CLI pages
- [ ] 5.7 Rewrite `qv-docs-update` as package-agnostic and contract-driven, fed by the binding check, and add a scaffold skill for `docs/users/`
- [ ] 5.8 Retire `qv-docs-line-cut` and `qv-docs-cutoff`
- [ ] 5.9 Sync the `docs-contract` and `docs-bindings` deltas into the main specs

## 6. CI and release automation

- [ ] 6.1 Extend the docs pull-request checks to `packages/*/docs/users/**`, examples, and generated data, building with overrides
- [ ] 6.2 Add the shared documentation-only classifier with tests for pure and mixed diffs
- [ ] 6.3 Exempt documentation-only pull requests in the release guards, and exclude `packages/*/docs/users/**` from publish triggers
- [ ] 6.4 Add the pin-update workflow for releases and for documentation-only merges into release branches
- [ ] 6.5 Update `docs/gitflow.md`, `docs/ci/RELEASE-TRAIN.md`, and `CONTRIBUTING.md` for documentation in packages and pin-based publication
- [ ] 6.6 Sync the `docs-release-workflow` delta into the main specs

## 7. Ecosystem packages

- [ ] 7.1 Add the Packages section to Ecosystem, composed from `kind: package` versions files, with the switcher
- [ ] 7.2 Add the TypeDoc normalizer and `docs:api`, which write `_generated/api.json` with a `--check` gate
- [ ] 7.3 Document `translation-nmtcpp`: `docs/users/`, maintainer docs moved to `docs/contributors/`, generated API, and a versions file
- [ ] 7.4 Document `llm-llamacpp` the same way
- [ ] 7.5 Delete the unpublished Software Inventory pages
- [ ] 7.6 Sync the `ecosystem-packages` and `software-inventory-docs` deltas into the main specs

## 8. Close-out

- [ ] 8.1 Validate every spec with `openspec validate --specs --strict`
- [ ] 8.2 Archive this change
