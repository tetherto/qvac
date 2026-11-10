---
name: qv-docs-update
description: >-
  Updates a package's documentation after a change to its code, for any
  software the docs website documents. Regenerates the API facts, finds the
  pages the change made out of date through their API bindings, and proposes
  the smallest edit that fixes them. Use when invoking /qv-docs-update.
disable-model-invocation: true
---

# Docs Update

A developer who finishes a change to a documented package invokes this skill, so the pull request opens with its documentation already in place.

Everything you write is read by a developer building a local AI application on QVAC. The docs website teaches how to use each software, never how its codebase works. Write for that reader.

Run this skill only when the developer asks. The API must be stable: prose written against a surface that is still moving is wasted.

## How documentation is organised

- Every documented software has a versions file, `docs/website/versions/<slug>.json`. Its `paths` list the folders the documentation reads, the first being the **documentation root**, `<package>/docs/users/`. Its `kind` is `product` or `platform`. Read the versions files; never assume which software exists.
- The documentation root on the current branch is the line this branch documents: the unreleased version on `main`, a released version on its release branch. Write there and nowhere else.
- **Some facts come from data.** Model lists, CLI commands and options, and HTTP operations are generated into `<documentation root>/_generated/` and the software's contract, and rendered by data components (`<SchemaTable>`, `<ModelsTable>`, `<CliReference>`, `<OpenApiReference>`). Never write such a fact as prose: regenerate it.
- **API reference pages are written by hand.** An SDK function's page (`reference/api/<function>.mdx`) and a package's `api.mdx` state signatures, options, and types in tables, read from the source: the client function, its TypeScript types, and the Zod schemas behind them. When a bound symbol changes, update the tables of every page `docs:bindings` names.
- **Prose is bound to the API.** A hand-written page declares the symbols it describes in its frontmatter, `binds: [fn:translate, command:qvac serve, "endpoint:POST /v1/chat/completions"]`. `api-bindings.lock.json` records the surface each binding was reviewed against. `npm run docs:bindings` (from `docs/website`) names every page whose bound surface changed, and every public symbol no page binds. `npm run docs:lock` records the review.

## What this skill reads and writes

Read the scope in [references/docs-scope.md](references/docs-scope.md) before writing anything. In short:

- Write hand-written pages and `meta.json` files under the documentation root of each software the change touches.
- Write `_generated/`, the contract, and generated reference pages only by running their generators.
- Write `api-bindings.lock.json` only by running `docs:lock`.
- Never edit package source, examples included. If source is wrong, report it and stop.

## Pipeline objects

| Object | Question it answers | Built in |
| --- | --- | --- |
| `SOURCE_CHANGE_SET` | What changed in the code, per software? | Phase 1 |
| `DOCS_IMPACT` | What does that mean for a user? | Phase 3 |
| `DOCS_TARGETS` | Which pages and sections became wrong, and why? | Phase 4 |
| `DOCS_PATCH` | What is the smallest change that fixes them? | Phase 5 |

`DOCS_IMPACT` is always one report. Never split it, and never estimate how many pages it touches: the bindings and the example references produce the pages.

## States

| State | Scope | Meaning |
| --- | --- | --- |
| `NO_SOURCE_CHANGE` | run | Nothing changed in any documented software against the merge base. |
| `NO_DOCS_IMPACT` | file | Code changed. Nothing user-facing went stale. |
| `GENERATED_DOCS_ONLY` | file | User-facing impact, fully carried by regenerated data. |
| `DOCS_UPDATE_REQUIRED` | file | Hand-written prose must change. |
| `NEW_PAGE` | symbol | A new public symbol whose topic no page covers. |
| `HUMAN_INPUT_REQUIRED` | file | An ambiguity the repository does not resolve. Ask the developer. |
| `DONE` | run | Every patch applied and every gate passed. |

Judge file-scoped states one source file at a time. One unresolved file never discards the patches for the others.

The final report carries one state. If any file is `HUMAN_INPUT_REQUIRED`, report it and list the resolved patches beside the question. Else if every gate passed, report `DONE`. Else report the state every file shares.

## Phase 1 — Collect the source change

1. Resolve the merge base against the remote that points at `tetherto/qvac` (or the base the developer names).

   ```bash
   git remote -v                      # find the remote for tetherto/qvac
   git merge-base HEAD <remote>/main
   ```

2. List every changed path across the four git states: committed on the branch, staged, unstaged, and untracked.

   ```bash
   git diff --name-status <base>
   git ls-files --others --exclude-standard
   ```

3. Assign each path to the software that owns it. A software owns its package root, the folder holding `docs/users/` of its documentation root, plus every folder in its `paths`. A path no software owns is out of scope. Drop changes inside documentation roots: they are documentation, not source.

4. If no path is owned, report `NO_SOURCE_CHANGE` and stop.

5. Write the `SOURCE_CHANGE_SET` block. Read each changed file's diff once, here; the later phases read this block, not the raw diff.

   ```text
   SOURCE_CHANGE_SET

   Base: tether/main @ 3f2a91c
   Software:
   - @qvac/sdk (product)
     - packages/sdk/src/client/api/completion-stream.ts   M  completion() gains `maxTokens`
     - packages/sdk/examples/completion-events.ts         M  demonstrates `maxTokens`
     - packages/sdk/test/completion-max-tokens.test.ts    A  caps output at maxTokens
   - @qvac/cli (product)
     - packages/cli/src/serve/index.ts                    M  --port default 11434 → 8080

   Context: commit subjects, the PR title and body when a PR exists.
   ```

   Include changed tests: a test often states new behaviour more plainly than the code.

## Phase 2 — Regenerate the facts

For each software in the `SOURCE_CHANGE_SET`, bring its generated data up to date with the working tree before judging any page. A page reviewed against stale data is reviewed against nothing.

1. Run the software's own generators: the scripts in its `package.json` that carry a `--check` gate (for the SDK, `contract:export`). Follow the package's README for setup.
2. Run the site's data scripts that name the software, from `docs/website`: the `docs:*-api` scripts in its `package.json` (for example `docs:sdk-api`, `docs:cli-api`). They write `_generated/` and the generated reference pages.
3. Run each of those scripts again with `--check`. Each must pass.

The diff of the generated data against the base, `git diff <base> -- <documentation root>/_generated <contract folder>`, is the exact statement of how the public surface changed. Read it in Phase 3.

## Phase 3 — Build `DOCS_IMPACT`

Read [references/docs-impact-policy.md](references/docs-impact-policy.md). Then answer two questions for the change:

- Did a claim the documentation makes stop being true, or become incomplete?
- With the documentation as it stands, can a user use what changed?

The first catches a stale page. The second catches a correct page that leaves the user unable to reach the new capability.

1. Write the `DOCS_IMPACT` block.

   ```text
   DOCS_IMPACT

   User-facing change:
   completion() accepts an optional maxTokens that caps the tokens generated.

   Public surface affected:
   - fn:completion (request gains `maxTokens`)

   Carried by data:
   - The reference page and every <SchemaTable fn="completion"> list `maxTokens`
     with its type and description.

   Documentary implication:
   Capping output is essential to controlling generation, so the capability
   page's prose must say when to reach for it.
   ```

2. If the repository does not settle whether a changed behaviour is public and supported, emit `HUMAN_INPUT_REQUIRED` with that exact question, and stop for that file. Documenting an accident of the implementation promises what the next change breaks.

3. If every file is `NO_DOCS_IMPACT` or `GENERATED_DOCS_ONLY`, emit the no-update report and stop. Name the data that carries a `GENERATED_DOCS_ONLY` claim.

## Phase 4 — Find `DOCS_TARGETS`

Candidates come from three sources, and their hits are unioned.

1. **Bindings.** Run the check for each software in the change, from `docs/website`.

   ```bash
   npm run docs:bindings -- <slug>
   ```

   Read each problem it names:

   | Problem | Meaning | Candidate |
   | --- | --- | --- |
   | `<symbol> changed since <page> was last reviewed` | the bound surface changed | that page |
   | `<page> binds <symbol>, which is not in the public surface` | the symbol was removed or renamed | that page: its prose and its `binds` |
   | `<symbol> is public, and no page binds it` | a symbol no page describes | Phase 4 step 4 |
   | `… no review of it` / `… no longer binds it` | lock bookkeeping | none; `docs:lock` settles it in Phase 6 |

   An uncovered symbol the change did not introduce is an existing gap. Report it; do not fill it unasked.

2. **Examples.** For each changed example file, search the documentation roots for the pages that import it. The `file=<rootDir>/<path>` directive is an exact binding. A TypeScript example also reaches the page that imports its transpiled `dist/**.js` counterpart.

   ```bash
   grep -rn "file=<rootDir>/<example path>" <documentation root>
   ```

3. **Behaviour outside the surface.** A changed default, limit, error condition, emitted event, or configuration key appears in no generated data. Search the documentation root for the identifiers involved. If a user-facing change reaches no page this way, emit `HUMAN_INPUT_REQUIRED` for that file and ask which page covers the topic.

4. **New symbols.** For each uncovered symbol the change introduced, decide where it belongs:
   - If an existing page covers its topic, that page is a candidate: the symbol gets a section there and joins its `binds`.
   - Else the state is `NEW_PAGE` for that symbol (Phase 5).

5. For each candidate, read the page itself, with `DOCS_IMPACT` in hand, and answer in writing: did this section become incorrect, incomplete, misleading, or materially insufficient? Keep it if yes, dismiss it if no, and write the reason either way. A drifted page whose prose is still true is dismissed with its reason; Phase 6 records its review in the lock.

   The `Reason` is the contract for the patch. Write it precisely.

6. Write the `DOCS_TARGETS` block, grouped by page.

   ```text
   DOCS_TARGETS — 2 pages, 2 targets

   packages/sdk/docs/users/ai-capabilities/text-generation.mdx
     1. Section: "Features"
        Via:     binding (fn:completion drifted: request gains maxTokens)
        Reason:  the list of generation controls omits the new cap.
        Action:  add a bullet on capping output with maxTokens.

   packages/cli/docs/users/http-server/index.mdx
     2. Section: "Running the server"
        Via:     behaviour (--port default changed)
        Reason:  states the server listens on 11434 by default; it is now 8080.
        Action:  correct the port in place.

   Dismissed:
   - packages/sdk/docs/users/ai-capabilities/batch-processing.mdx
     Via:    binding (fn:completion drifted)
     Reason: mentions completion() only for comparison; no claim went stale.
   ```

There is no page limit. "One change, one scope" is about the source, not about how many pages document it. The gate against wide routing is the written reason, not a count.

## Phase 5 — Write and apply `DOCS_PATCH`

Read [references/editorial-guidelines.md](references/editorial-guidelines.md). Work page by page, so the developer reviews one file at a time.

1. Read the whole target page, then locate the target section.
2. Write the smallest change that settles the target's `Reason`, and nothing beyond it. If the new text asserts something the `Reason` does not support, delete it and write it again.
3. Never restate a fact a data component renders. A new field, model, option, or operation reaches the page through its component; prose says when and why to use it.
4. Keep `binds` true: add a symbol the page now describes, remove one it no longer does.
5. Present the diff to the developer. If they approve, apply it and preserve the rest of the page byte for byte. Else revise and present it again.

### `NEW_PAGE`

A new public symbol whose topic no page covers gets a page.

1. Choose the folder whose pages cover the nearest topic, and follow the shape of its closest sibling: frontmatter, section order, components, the example block.
2. Create the page with `binds` listing the symbols it describes.
3. Append its slug at the end of the folder's `meta.json` `pages` array. The array is the folder's whole sidebar; a page absent from it is invisible.
4. If the documentation root has a page that enumerates the folder's pages (an overview list), append one entry there, matching its neighbours.
5. Declare an `icon` when the siblings do, and flag it in the report as needing editorial confirmation.
6. If the page also belongs in a listing outside the documentation root, such as the Ecosystem overview, do not edit it. Name it in the report for the documentation owner.

If the topic fits no folder, emit `HUMAN_INPUT_REQUIRED` and ask where it belongs. Reorganising pages is an information-architecture decision, never this skill's.

## Phase 6 — Record the review and validate

Run the gates in order. If any fails, report it, leave the patches on disk, and do not declare `DONE`.

1. **Scope.** List the files this run wrote and check each against [references/docs-scope.md](references/docs-scope.md). Check what the run wrote, never the dirty tree: the developer's source changes are expected. A write outside the scope aborts the run; revert what was applied.
2. **Diff review.** Read the full diff. Check which files and sections were touched, that each patch is proportional to the change, and that no unrelated edit slipped in. This is the only gate that catches a well-formed but false sentence, so never skip it. It relies on the reviewer being the change's author; if that is not so, say it in the report instead of declaring `DONE`.
3. **Grounding.** Every symbol a patch cites exists in the regenerated data, and every `file=` directive it introduces resolves to a file.
4. **Lock.** Once every candidate from a binding is patched or dismissed with its reason, record the review, from `docs/website`. The lock change appears in the pull request's diff as the record of that review.

   ```bash
   npm run docs:lock -- <slug>
   npm run docs:bindings -- <slug>
   ```

   The check must pass, except for uncovered symbols this change did not introduce, which the report lists as existing gaps.
5. **Freshness.** Every generator from Phase 2 passes with `--check`.
6. **Site.** From `docs/website`:

   ```bash
   npm test                 # link integrity and line structure, development lines included
   npm run test:examples    # file references, example type-check, transpilation
   npm run dev              # renders each development line at /<slug>/preview/
   ```

   Open every patched page at `/<slug>/preview/<page>` and confirm it renders.

## Report formats

Run with updates:

```text
qv-docs-update — DONE

Source impact:
completion() accepts an optional maxTokens that caps the tokens generated.

Regenerated:
- @qvac/sdk: contract, _generated/js-api.json

Targets:
- packages/sdk/docs/users/reference/api/completion.mdx  "CompletionOptions" table  via binding (fn:completion)
- packages/sdk/docs/users/ai-capabilities/text-generation.mdx  "Features"  via binding (fn:completion)

Reviewed without change:
- packages/sdk/docs/users/ai-capabilities/batch-processing.mdx  (fn:completion; no claim went stale)

Existing gaps (not introduced here):
- command:qvac verify is public, and no page binds it.

Validation:
- scope ok · diff reviewed · grounding ok · lock recorded · freshness ok · test ok · test:examples ok · preview ok
```

Run with no update:

```text
qv-docs-update — NO_DOCS_IMPACT

Changes detected in @qvac/sdk (packages/sdk/src/server/rpc.ts).
No public surface changed; no documented claim became incorrect or incomplete.
```

Run partially blocked:

```text
qv-docs-update — HUMAN_INPUT_REQUIRED

Resolved:
- packages/sdk/docs/users/ai-capabilities/text-generation.mdx  "Features"  (patch awaiting approval)

Pending:
- packages/sdk/src/client/config-loader.ts changes a user-facing default and
  no page mentions it. Which page covers this topic?
```

## Out of scope

- Editing package source or examples.
- Writing generated data, generated pages, or the lock by hand.
- Writing to any documentation line other than the one the current branch holds.
- Editing site code, or content outside documentation roots.
- Reorganising pages, or creating a page for anything but a new public symbol no page covers.
- Running automatically. A developer invokes this skill.

## Files

- [references/docs-scope.md](references/docs-scope.md) — what the skill may write.
- [references/docs-impact-policy.md](references/docs-impact-policy.md) — what counts as user-facing impact.
- [references/editorial-guidelines.md](references/editorial-guidelines.md) — how to write the patch, and the SDK's page conventions.
