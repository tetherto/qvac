---
name: qv-docs-update
description: >-
  Updates the docs website after a change to the SDK or CLI. Finds the pages
  your change made out of date and proposes the smallest edit that fixes them.
  Use when invoking /qv-docs-update.
disable-model-invocation: true
---

# Docs Update

Whenever a developer finishes implementing a feature in the SDK or the CLI, they invoke this skill to update the docs website, adding or updating the content. That way, every new feature PR opens with its documentation already in place.

Route a source change to the documentation pages it invalidated. Propose the smallest patch that makes them correct again.

Everything you write is read by a developer building a local AI application on QVAC, an open-source ecosystem. `docs/website` is their developer portal: it teaches how to use the SDK and the CLI, never how the codebase works internally. Write for that reader in Phase 3 and Phase 5.

Run this skill only when the developer asks for it. The source API must be stable. Do not run it mid-implementation: developers iterate on an API several times before it settles, and prose written against a moving surface is the waste this skill exists to avoid.

## What this skill reads and writes

There are three observed source packages: `packages/sdk`, `packages/sdk-python`, `packages/cli`. They are read-only.

Never edit anything under `packages/**`. If a source file is wrong, report it and stop. Fixing source is the developer's job.

The writable surface is defined in [references/docs-scope.md](references/docs-scope.md). Read that file before writing anything. A write outside the allowlist aborts the run and reverts every patch already applied.

## Pipeline objects

The skill builds four objects, in order. Each one appears as a block in the final report.

| Object | Question it answers | Built in |
| --- | --- | --- |
| `SOURCE_CHANGE_SET` | What changed in the code? | Phase 2 |
| `DOCS_IMPACT` | What does that mean for a user? | Phase 3 |
| `DOCS_TARGETS` | Which pages and sections became wrong, and why? | Phase 4 |
| `DOCS_PATCH` | What is the smallest change that fixes them? | Phase 5 |

Cardinality:

```text
1 SOURCE_CHANGE_SET  ->  1 DOCS_IMPACT   (always one, never split)
1 DOCS_IMPACT        ->  N pages         (routing is a union of hits)
1 page               ->  N targets       (distinct sections of that page)
1 target             ->  1 reason + 1 patch
```

`DOCS_IMPACT` is always a single report. Never split it. Never estimate how many pages it will touch. The router produces the page grouping, deterministically.

You have exactly two jobs in this pipeline, and both are verifiable: describe the change (Phase 3), and judge a concrete page you have in front of you (Phase 4). Nothing here asks you how many independent impacts a change contains. That question has no ground truth, and nothing downstream needs the answer.

## States

A state classifies the documentary impact of a change, and decides what the skill does next: proceed to routing, stop and report, or ask the developer a question.

There are seven. Five classify one source file. Two describe the whole run.

| State | Scope | Meaning |
| --- | --- | --- |
| `NO_SOURCE_CHANGE` | run | Nothing changed in the three packages against the merge base. |
| `NO_DOCS_IMPACT` | file | Code changed. Nothing user-facing went stale. |
| `GENERATED_DOCS_ONLY` | file | User-facing impact, fully covered by a generated surface. |
| `DOCS_UPDATE_REQUIRED` | file | Editable prose must change. Proceed to routing. |
| `NEW_CAPABILITY_PAGE` | file | New AI capability with no page. The skill creates it. |
| `HUMAN_INPUT_REQUIRED` | file | An ambiguity the repo does not resolve. Ask the developer. |
| `DONE` | run | Every patch applied and validated. |

Assign the file-scoped states one source file at a time. If one file is unresolved, keep the patches already proposed for the files that routed cleanly.

Both scripts report a single run-level `state` field, and it is **advisory**. You own the state machine, not the scripts.

The collector decides only the two states it can prove alone, `NO_SOURCE_CHANGE` and `NO_DOCS_IMPACT`, and reports `CONTINUE` for everything else. `CONTINUE` is not one of the seven states: it means the script reached no verdict and Phase 3 must judge. The router reports its best guess from the routing signals it can see. Treat either field as a starting point, then refine per file as you work.

The final report carries one state in its header. Choose it this way. If any file is `HUMAN_INPUT_REQUIRED`, then report `HUMAN_INPUT_REQUIRED`, and list the resolved patches alongside the pending question. Else if every patch was applied and validated, then report `DONE`. Else report the state that every file shares.

## Decision flow

This is every path through the skill, and every point where it stops. The phases below implement this flow.

```text
Developer finishes the feature
        │
        ▼
  /qv-docs-update
        │
        ▼
Phase 1 — resolve the merge base; collect committed, staged,
          unstaged and untracked changes
        │
        ├── nothing changed ──────────────► NO_SOURCE_CHANGE      STOP
        ├── every changed file `internal` ─► NO_DOCS_IMPACT       STOP
        ▼
Phase 1 — export diff, TSDoc diff, auxiliary context
        │
        ▼
Phase 2 — build SOURCE_CHANGE_SET
        │
        ▼
Phase 3 — classify against the impact policy
        │
        ├── nothing user-facing ──────────► NO_DOCS_IMPACT        STOP
        ├── a generated surface covers it ─► GENERATED_DOCS_ONLY  STOP
        ├── is the behaviour supported? ──► HUMAN_INPUT_REQUIRED  STOP
        │   the repo does not say
        ▼
      DOCS_UPDATE_REQUIRED
        │
        ▼
Phase 4 — run the router
        │
        ├── new_capability_symbols ───────► NEW_CAPABILITY_PAGE
        │                                   four append-only edits,
        │                                   then Phase 6
        │
        ├── unrouted and user-facing ─────► HUMAN_INPUT_REQUIRED
        │                                   for that source only;
        │                                   routed pages continue
        ▼
Phase 4 — filter each candidate; write one reason for each
        │
        ▼
Phase 5 — write the patch; present the diff
        │
        ├── developer rejects ────────────► revise, present again
        ▼
Apply to disk
        │
        ▼
Phase 6 — five gates
        │
        ├── any gate fails ───────────────► report the error, leave
        │                                   the patches on disk,
        │                                   do not declare DONE    STOP
        ▼
      DONE
```

## Phase 1 — Collect the source change

- **Inputs:** the current git working tree.
- **Outputs:** `/tmp/qv-docs-scs.json` (written by the script), plus three records you gather by hand: export diff, TSDoc diff, auxiliary context.
- **Expected result:** every changed path in the three packages is accounted for and carries a bucket, across all four git states. A file missed here is invisible to every later phase.

Start with the script. It resolves the merge base, collects changes across all four git states (committed on the branch, staged, unstaged, untracked), and classifies every path into a bucket.

1. Run the collector.

```bash
bash .cursor/skills/qv-docs-update/scripts/collect-source-changes.sh > /tmp/qv-docs-scs.json
```

The output has this shape:

```json
{
  "state": "CONTINUE",
  "base": { "ref": "origin/main", "sha": "3f2a91c…", "short": "3f2a91c" },
  "strong_evidence": true,
  "buckets": ["api", "examples"],
  "file_count": 2,
  "files": [{ "path": "packages/sdk/src/client/api/completion-stream.ts", "bucket": "api", "status": "M" }]
}
```

Each file carries a bucket. The bucket decides which router runs in Phase 4.

| Bucket | Paths |
| --- | --- |
| `examples` | `packages/{sdk,sdk-python}/examples/**` |
| `api` | `packages/sdk/src/client/api/**` |
| `client-other` | `packages/sdk/src/client/**` outside `api/` |
| `surface` | barrels, `src/types/**`, `src/schemas/**` |
| `cli-command` | `packages/cli/src/{bundle-sdk,serve,configure,openai,doctor,verify}/**` |
| `cli-infra` | `packages/cli/src/cli/**`, `src/{config,errors,logger,index}.ts` |
| `python-surface` | `packages/sdk-python/**` outside `examples/` |
| `area` | `packages/sdk/src/{logging,models,server,worker}/**` |
| `internal` | everything else |

The script decides two states on its own. It reports `NO_SOURCE_CHANGE` when nothing changed, and `NO_DOCS_IMPACT` when every changed file is `internal`. Every other run reports `CONTINUE`: changes exist, and their documentary impact is Phase 3's to judge.

2. If `state` is `NO_SOURCE_CHANGE` or `NO_DOCS_IMPACT`, then stop and emit the no-update report. Else continue.

`strong_evidence` is `true` when any of `examples`, `api`, or `cli-command` was touched. Treat it as weight in Phase 3, not as a verdict. Do not put it in the report.

The script cannot read the public export surface. Get it from the barrel, comparing the base against the working tree.

3. If no changed file is in the `api` or `surface` bucket, then skip to step 5. Else read the barrel at the base and in the working tree, and record added, removed, and renamed exports.

```bash
git show <base-sha>:packages/sdk/src/client/api/index.ts
```

Compare it against the current `packages/sdk/src/client/api/index.ts`. The barrel is the authority on what is public.

4. Read the diff of every file in the `api` and `surface` buckets, then record each changed function signature and each changed TSDoc block.

```bash
git diff <base-sha> -- <file-path>
```

For an untracked file, read the file directly. There is no diff to read.

5. Gather auxiliary context.

Collect three things: the branch commit messages (`git log <base-sha>..HEAD --format=%s`), the PR title and body (`gh pr view --json title,body`, only when a PR exists), and any changed test that exercises an affected symbol. A new test often states new behaviour more plainly than the diff does.

## Phase 2 — Build `SOURCE_CHANGE_SET`

- **Inputs:** everything collected in Phase 1.
- **Outputs:** one `SOURCE_CHANGE_SET` text block.
- **Expected result:** the block carries every fact the later phases need, so nothing downstream has to reopen the raw diff.

This object is what you read from here on. Do not go back to the raw diff after this phase.

1. Write the `SOURCE_CHANGE_SET` block in this exact shape.

```text
SOURCE_CHANGE_SET

Base: origin/main @ 3f2a91c
Packages: packages/sdk

Buckets:
- api:       packages/sdk/src/client/api/completion-stream.ts
- examples:  packages/sdk/examples/completion-events.ts
- surface:   packages/sdk/src/types/generation.ts

Exports:
- changed:   completion() — new optional parameter `maxTokens?: number`
- unchanged: all others

TSDoc:
- completion(): @param maxTokens added

Tests:
- packages/sdk/test/completion-max-tokens.test.ts (new)
```

## Phase 3 — Build `DOCS_IMPACT`

- **Inputs:** the `SOURCE_CHANGE_SET` block, and [references/docs-impact-policy.md](references/docs-impact-policy.md).
- **Outputs:** one `DOCS_IMPACT` text block, and a state.
- **Expected result:** the block states the change in the user's terms, not the code's, and every later claim in a patch traces back to something written here.

The question here is not "did the code change?". Phase 1 already answered that. Ask two questions instead, and answer both.

First: did a claim the docs make stop being true, or become incomplete?

Second: with the docs exactly as they stand today, can a user use the feature that changed?

The two catch different failures. The first catches a page that went stale. The second catches a page that is still entirely correct and yet leaves the user unable to reach the new capability. A new optional parameter usually makes no existing sentence false, and still leaves the user with no way to learn that the parameter exists. If the answer to either question is bad, the change has documentary impact.

1. Read [references/docs-impact-policy.md](references/docs-impact-policy.md).

2. Write the `DOCS_IMPACT` block in this exact shape.

```text
DOCS_IMPACT

User-facing change:
completion() accepts an optional maxTokens parameter.

Public surface affected:
- completion()
- GenerateTextOptions.maxTokens

Behaviour:
- maxTokens caps the total tokens generated in the response.
- Omitted, current behaviour is unchanged.

Generated coverage:
- The API summary will list completion() with the new signature.
- The API summary will NOT describe what maxTokens means. It omits parameter descriptions by design.

Documentary implication:
maxTokens is essential to controlling output, so it belongs on the capability page, per the policy on essential parameters.
```

3. If the repo does not settle whether the changed behaviour is public and supported, then emit `HUMAN_INPUT_REQUIRED`, put that exact question to the developer, and stop.

This is the impact ambiguity, not the routing one. It appears when an observable behaviour changed and no barrel export, no TSDoc, no test and no page says whether that behaviour is part of the contract or an accident of the implementation. Documenting an accident is worse than documenting nothing, because the next change silently breaks a promise the docs made. Ask instead of inferring. Phase 4 raises the same state for a different reason: there the behaviour is known and the page is not.

4. If the state is `NO_DOCS_IMPACT` or `GENERATED_DOCS_ONLY`, then stop and emit the no-update report. Else continue.

When you claim `GENERATED_DOCS_ONLY`, name the covering surface in the report. An unnamed claim is not checkable.

## Phase 4 — Route to `DOCS_TARGETS`

- **Inputs:** `/tmp/qv-docs-scs.json`, and the `DOCS_IMPACT` block.
- **Outputs:** one `DOCS_TARGETS` block, grouped by page, with a written reason per candidate.
- **Expected result:** every candidate the router produced is either kept with a reason, or dismissed with a reason. None is silently dropped.

The router reads the JSON from Phase 1, not the `SOURCE_CHANGE_SET`.

1. Run the router.

```bash
bun run .cursor/skills/qv-docs-update/scripts/route-docs-targets.ts --input /tmp/qv-docs-scs.json
```

The output has this shape:

```json
{
  "state": "DOCS_UPDATE_REQUIRED",
  "base": { "ref": "origin/main", "sha": "3f2a91c…", "short": "3f2a91c" },
  "r3_used": false,
  "high_page_count": false,
  "new_capability_symbols": [],
  "pages": [
    {
      "page": "ai-capabilities/text-generation.mdx",
      "targets": [
        {
          "page": "ai-capabilities/text-generation.mdx",
          "section": "Examples › Usage",
          "sectionLevel": 3,
          "via": "R1",
          "source": "packages/sdk/examples/completion-events.ts",
          "evidence": "file=<rootDir>/packages/sdk/examples/completion-events.ts",
          "line": 185
        }
      ]
    }
  ],
  "unrouted": [{ "source": "…", "bucket": "…", "status": "M", "reason": "…" }],
  "discarded": [{ "page": "…", "source": "…", "via": "R4", "reason": "…" }]
}
```

Read the fields as follows:

- `pages[].targets[]` are the candidates. Each one is a page section to judge in step 3.
- `evidence` is the authored binding the router matched. It is a fact about the repo, not a guess.
- `line` is where that binding sits in the page. Use it to find the section fast.
- `section` is `null` on a page-level hit: every R3 hit, and the `cli/http-server/**` subtree of R4. The router bound the page, not a section, because the map and the subtree rule name pages only.
- `unrouted[]` are source files no router could place. Handle them in step 5.
- `discarded[]` are hits that fell outside the allowlist or hit a path declared undocumented. Copy them into the report. Never re-add them.
- `new_capability_symbols[]` are new exported symbols in `client/api/` with no page. Each one means `NEW_CAPABILITY_PAGE`.
- `r3_used` is `true` only when **every** hit came from the area map. It is run-level, so a run with one R1 hit and one R3 hit reports `false`. To weigh a single candidate, read its `via` field instead: R3 is the declared fallback, so treat an R3 candidate with more suspicion than an R1, R2 or R4 hit.
- `high_page_count` is `true` when the router produced more than four pages. It is counted before your filtering, so recount after step 3.

There are four routers, and their hits are unioned. R1, R2 and R4 are exact: each resolves a binding that already exists in the content. R3 is the declared fallback and labels itself as such.

| Router | Binding it resolves | Buckets it covers |
| --- | --- | --- |
| R1 | the literal `file=<rootDir>/…` directive in a fence | `examples` |
| R2 | the `/reference/api#<symbol>` anchor | `api`, export diff |
| R4 | the `` ### `qvac <command>` `` heading | `cli-command` |
| R3 | [references/routing-map.yaml](references/routing-map.yaml) | everything else |

Four router behaviours affect how you read the output:

- R1 has no false-positive mode. No page inlines a full example. A TS example also routes the page that shows its transpiled `dist/**.js` counterpart.
- R2 takes symbols from the barrel, not the filename. `completion-stream.ts` exports `completion`, so the anchor is `#completion` and never `#completionstream`. `rag.ts` exports nine functions and `transcribe.ts` exports two. Use the same rule when you write a link in a patch.
- R2 also has a secondary pass for a symbol linked somewhere other than its anchor, reported as the weaker binding. `text-generation.mdx` links `` [`batchCompletion()`](/ai-capabilities/batch-processing) `` and carries a paragraph on how that function shares `parallel` slots. That page is a real target even though the anchor is absent. A symbol mentioned in prose with no link at all is routed by nothing.
- R4 also routes the narrative sections that describe a command outside `## Reference`, and for `serve/` it adds the whole `cli/http-server/**` subtree.
- R3 runs per file, not per run. It picks up only the files the exact routers could not resolve. A commit that touches an example and a config module gets an R1 hit for the example, and R3 still runs for the config module. One file's exact hit never suppresses the fallback for another file.

A `pages: []` entry in the routing map is a positive declaration that a path is intentionally not documented. It is why a file can be unrouted without becoming a question.

2. Read each candidate section in the page it belongs to.

Judge the page itself, not the diff. Read the section with `DOCS_IMPACT` in hand.

If `section` is `null`, then read the whole page and choose the section yourself, then state that choice and its justification in the candidate's `Reason`. This is the one place where you pick a target the router did not name, so make the choice auditable rather than silent. If no section on the page fits, dismiss the candidate — do not invent a section for it.

3. For each candidate, answer this question in writing: did this section become incorrect, incomplete, misleading, or materially insufficient after the change described in `DOCS_IMPACT`?

Keep the candidate if the answer is yes. Dismiss it if the answer is no. Either way, write the reason. A page that routed by accident has no answer to "which claim here went stale?", and that is what removes it.

The `Reason` field is the contract for the patch. Phase 5 is bound to it, so write it precisely.

4. Write the `DOCS_TARGETS` block, grouped by page, in this exact shape.

```text
DOCS_TARGETS — 2 pages, 3 targets

ai-capabilities/text-generation.mdx
  1. Section: "Features"
     Via:     R2 (completion -> /reference/api#completion)
     Reason:  the list of generation controls is complete today and would
              become incomplete by omitting maxTokens.
     Action:  list maxTokens among the controls.

  2. Section: "Examples › Usage"
     Via:     R1 (packages/sdk/examples/completion-events.ts)
     Reason:  the introductory sentence describes what the script does, and the
              script now demonstrates the new parameter.
     Action:  update the introductory sentence.

configuration/index.mdx
  3. Section: "Reference"
     Via:     R3 (packages/sdk/src/client/config-loader/**)
     Reason:  R3 bound the page and named no section; "Reference" is the only
              section that enumerates config keys, and its key table lacks the
              new one.
     Action:  add the key, its accepted values, and its default.

Dismissed:
- ai-capabilities/batch-processing.mdx
  Reason: links completion() only by comparison; no claim went stale.
```

There is no page limit, and multi-page is a normal result.

The team rule "1 change == 1 scope" describes the scope of the change in the source. It says nothing about how many pages document that change, and the two are different quantities. A new CLI command that reads a new config key is perfectly scoped, and it needs both `cli/index.mdx` and the configuration page. Do not drop a target to keep the page count down. The gate against wide routing is the written reason, not a count.

5. If more than four pages survived filtering, then emit this note and continue. It never blocks.

```text
Routing produced 6 pages after filtering. That is allowed but uncommon. Worth
checking whether routing went wide (candidates that should have been dismissed)
or the source change mixes scopes. The patches stand.
```

6. For each entry in `new_capability_symbols[]`, run the `NEW_CAPABILITY_PAGE` subprocedure, below.

7. For each entry in `unrouted[]` that is user-facing **and carries no `newSymbol`**, emit `HUMAN_INPUT_REQUIRED` for that source and ask which page covers the topic.

`new_capability_symbols[]` is derived from `unrouted[]`, so a new symbol appears in both lists. Step 6 already handled it. Asking about it here would create the page and then ask which page covers the topic.

The answer becomes a new `routing-map.yaml` entry. That is how the map grows. A source file that is not user-facing needs no question: ignore it.

## Phase 5 — Write and apply `DOCS_PATCH`

- **Inputs:** the `DOCS_TARGETS` block, and [references/editorial-guidelines.md](references/editorial-guidelines.md).
- **Outputs:** one patch per target, applied to disk after approval.
- **Expected result:** each patch settles exactly one target's `Reason`, and changes nothing else.

Work page by page. Close every target on one page before opening the next, so the developer reviews one file at a time.

1. Read [references/editorial-guidelines.md](references/editorial-guidelines.md).

2. Read the whole target page, then locate the target section by its heading.

3. Write the smallest change that settles that target's `Reason`, and nothing beyond it.

If the new text asserts something the `Reason` does not support, it is scope creep or hallucination. Delete it and write it again.

Match the patch to the change type:

| Change in the source | Patch to write |
| --- | --- |
| Existing example modified | Update the script's introductory sentence. Take it from the example's own top-of-file comment. |
| New example using existing functions | Add a `###` subsection under `Examples`: one introductory sentence, then a complete `<Tabs>` block for the language files that exist. |
| New essential parameter on an existing function | Document it on the capability page, as a `Features` bullet or as prose in the relevant section. Follow `text-generation.mdx`. |
| Observable behaviour changed | Correct the stale statement in place. Do not rewrite the section. |
| New function in an existing capability | Add it to the `Functions` list with a `/reference/api#<symbol>` link. |
| New flag on an existing CLI command | Document it inside that command's own `###` block in `cli/index.mdx`, following how the neighbouring flags are shown. |
| New CLI command | Add a `` ### `qvac <command>` `` heading under `## Reference` in `cli/index.mdx`, matching the shape of the commands already there. Never a new page. |
| New function that institutes a new capability | Run the `NEW_CAPABILITY_PAGE` subprocedure, below. |

4. Present the diff to the developer before writing to disk.

5. If the developer approves, then apply the patch and preserve the rest of the page byte for byte. Else revise the patch and present it again.

## Phase 6 — Validate

- **Inputs:** the applied patches.
- **Outputs:** a pass or fail per gate, reported in the `Validation:` block.
- **Expected result:** all five gates pass, and the state becomes `DONE`.

There are five gates. Run them in order. If any gate fails, report the error, leave the patches on disk for the developer to fix, and do not declare `DONE`.

1. List the files **this run wrote** — the targets patched in Phase 5, plus the four registration points when the `NEW_CAPABILITY_PAGE` subprocedure ran — and check each one against the allowlist in [references/docs-scope.md](references/docs-scope.md).

Check the files this run wrote, never the dirty working tree. The tree legitimately holds the developer's own changes under `packages/**`, which Phase 1 collected on purpose. Treating those as scope violations would abort every run. To confirm nothing else in the website was touched, run `git status --short -- docs/website/` and verify that every path it lists is one you wrote.

A file outside the allowlist aborts the run. Revert everything already applied. `index.mdx` and `custom-tree.ts` pass only when the diff is an append inside the AI-capabilities block.

2. Run `git diff` and review the full diff.

Check three things: which files and sections were touched, whether the patch is proportional to the source change, and whether any editorial edit unrelated to the source change slipped in. Remove anything unrelated.

This review is the only gate that catches a well-formed but false sentence. Every other gate catches a broken patch: invalid MDX, a `file=` pointing at nothing, a dead route. A sentence claiming a default is `512` when it is `1024` compiles, renders, and passes all of them. Do not skip this gate.

The skill relies on the developer here, and that works because the reviewer is the person who just wrote the feature. If this skill is ever run where the reviewer is not the feature's author — a CI companion, a sweep over someone else's branch, a batch over old commits — that premise no longer holds. Say so in the report instead of declaring `DONE`.

3. Check that every symbol cited in a patch exists in `packages/sdk/src/client/api/index.ts`, and that every `file=` directive introduced resolves to a real file on disk.

4. If the run created a capability page, then run the parity script.

```bash
bun run .cursor/skills/qv-docs-update/scripts/check-capability-parity.ts
```

It cross-checks all four registration points, verifies the card's icon is imported and matches the sidebar's, and catches registrations pointing at pages that do not exist. Three of the four points fail silently without it: omit the card, the bullet, or the sidebar entry and the build still succeeds, the tests still pass, and the capability is missing everywhere a user would look.

5. Run the website suites from `docs/website/`.

```bash
bun run test:examples   # file refs, example type-check, transpilation, inline blocks, Python
bun run test            # website suite (link integrity, open graph, …)
bun run build           # static build; catches broken MDX and broken routes
```

## Subprocedure — `NEW_CAPABILITY_PAGE`

This is not a phase. It is a conditional subprocedure, and it runs only when a change institutes a new AI capability. Two places call it: Phase 4, for each entry in `new_capability_symbols[]`, and Phase 5, for the last row of the patch-shape table. When it finishes, go to Phase 6. Gate 4 exists to validate it.

- **Inputs:** the new symbol, its example file, and its model family.
- **Outputs:** four edits: one new page, three appends.
- **Expected result:** the parity script in Phase 6 passes.

A new capability is not "create an MDX". It is one operation with four points, every time. All four are appends. Nothing else is touched.

| # | File | Operation |
| --- | --- | --- |
| 1 | `content/docs/ai-capabilities/<slug>.mdx` | **create**, from [references/capability-page-template.mdx](references/capability-page-template.mdx) |
| 2 | `content/docs/index.mdx` | **append** 1 `<Card>` at the end of the `## AI capabilities` grid, **and** 1 identifier to the `lucide-react` import |
| 3 | `content/docs/introduction.mdx` | **append** 1 bullet at the end of the `### AI tasks` list |
| 4 | `src/lib/custom-tree.ts` | **append** 1 entry at the end of the `AI capabilities` block |

1. If the change requires touching any file outside those four, then stop and emit `HUMAN_INPUT_REQUIRED`. The case is not a new capability.

2. Create the page from the template.

3. Append the card and its icon import to `content/docs/index.mdx`.

Both edits are required. Without the import, the build breaks.

```mdx
import { MessagesSquare, /* … */, Shapes, Eye, Brain, /* … */ } from 'lucide-react'
```

```mdx
  <Card href="/ai-capabilities/image-classification" title={<span className="inline-flex items-center gap-2"><Shapes className="size-4 text-[var(--color-fd-primary)]" />Image classification</span>}>
    Classify images into labels with confidence scores via a customized GGML backend.
  </Card>
```

If the icon name collides in MDX scope, then alias it. `Image` is imported as `Image as ImageIcon` for that reason.

4. Append the bullet to `content/docs/introduction.mdx`.

```mdx
* [**Image classification:**](/ai-capabilities/image-classification) assigning class labels with confidence scores to images, via [a customized GGML backend](https://github.com/tetherto/qvac/tree/main/packages/classification-ggml).
```

5. Append the sidebar entry to `src/lib/custom-tree.ts`, between the `AI capabilities` and `P2P capabilities` separators.

The sidebar is a hand-maintained tree. It is not derived from the filesystem. Without this entry the page is reachable by URL and invisible in navigation.

```ts
{
  name: 'Image classification',
  url: '/ai-capabilities/image-classification',
  type: 'page',
  icon: resolveIcon('Shapes'),
},
```

6. Use the same icon in the card (step 3) and the sidebar entry (step 5).

The icon is not derivable from the source. Propose a Lucide name and flag it in the report as needing editorial confirmation.

7. Write the card and bullet descriptions from this formula, which is already present as an MDX comment in both files.

```mdx
{/* <Task name>: <what computation is performed> for <what the developer achieves> via <engine> */}
```

Base all three strings — frontmatter `description`, card, bullet — on the same sentence. They describe the same thing at different lengths and must agree.

## Report formats

Emit one of these three at the end of the run.

Run with updates:

```text
qv-docs-update — DONE

Source impact:
completion() accepts an optional maxTokens parameter.

Routing:
- ai-capabilities/text-generation.mdx  via R2 (symbol)  -> section "Features"
- ai-capabilities/text-generation.mdx  via R1 (example) -> section "Examples › Usage"

Generated coverage:
- The API summary covers the signature. It does not cover the parameter's meaning.

Documentation updated:
- ai-capabilities/text-generation.mdx (2 sections, +7 −2)

Validation:
- scope ok
- diff reviewed
- grounding ok
- test:examples ok
- test ok
- build ok
```

Run with no update:

```text
qv-docs-update — NO_DOCS_IMPACT

Changes detected in packages/sdk (buckets: internal, client-other).
No public surface changed; no documentary claim became incorrect or incomplete.
```

Run partially blocked. The resolved patch survives:

```text
qv-docs-update — HUMAN_INPUT_REQUIRED

Source impact:
completion() accepts an optional maxTokens parameter.

Resolved:
- ai-capabilities/text-generation.mdx  "Features"  via R2  +4 −0
  (patch proposed, awaiting approval)

Pending:
- The change in src/types/streaming.ts is user-facing and no router hit. Which
  page covers this topic? The answer becomes a new routing-map.yaml entry.

The proposed patch stands — answering the pending question does not invalidate it.
```

## Out of scope

Do not do any of the following:

- Route by anything other than the four bindings and the declared area map. There is no `covers` frontmatter, no embeddings, no semantic search.
- Add managed markers inside MDX. The allowlist is path-level only.
- Ground a patch beyond symbol existence and `file=` resolution. Broad factual validation is v2. The developer reviewing the diff wrote the feature, so they catch a false claim.
- Judge the style guide with a second model pass.
- Trigger this skill automatically. Hook-based auto-detection belongs to a CI companion outside this skill.
- Create a page for anything other than a new AI capability. A new page from an information-architecture decision is permanently out of scope: it is not derivable from a source change. A new CLI command is a new section of `cli/index.mdx`. A new Python example is a tab on an existing page, or a section of `python-sdk.mdx`.

## Files

- [references/docs-scope.md](references/docs-scope.md) — allowlist, denylist, append-only surfaces.
- [references/docs-impact-policy.md](references/docs-impact-policy.md) — what counts as user-facing impact.
- [references/routing-map.yaml](references/routing-map.yaml) — the R3 area map.
- [references/editorial-guidelines.md](references/editorial-guidelines.md) — how to write the patch.
- [references/capability-page-template.mdx](references/capability-page-template.mdx) — skeleton for a new capability page.
- `scripts/collect-source-changes.sh` — Phase 1.
- `scripts/route-docs-targets.ts` — Phase 4.
- `scripts/check-capability-parity.ts` — Phase 6, gate 4.
