---
name: qv-merge-guard-wire
description: Wire a new CI job/workflow into the qvac-merge-guard / validate-pr aggregated required status check, and (if actually needed) register a new required check on the branch ruleset
disable-model-invocation: true
---

# Merge Guard Wire — hook a new job into the required status check

`qvac-merge-guard / validate-pr` is the **single** required status check on `main`. Adding a new CI job without wiring it into this aggregate creates a second, disconnected check the branch ruleset never requires — its failures become invisible. This skill covers both halves: wiring a job into the existing aggregate (the common case), and registering a genuinely new standalone required check on the ruleset (the rare case).

Full reference with diagrams and worked examples: `docs/ci/MERGE-GUARD.md`.

## When to use

- Adding **any** new job/workflow that should block merges — regardless of domain (addon package check, SDK check, docs validation, security scan, licensing gate, anything).
- A PR review flags a new job that isn't reflected in `qvac-merge-guard`'s pass/fail.
- Deciding whether a check needs to be registered as required on the ruleset at all, and if so, how.

**Part A and Part B are not alternatives to choose between — Part A is what you almost always do; Part B is a separate, additive question you ask afterward, not a fork in the road.** Every new merge-gating job folds into `qvac-merge-guard` (Part A) — there is no "or make it standalone instead" choice, because the ruleset only ever requires the one aggregated check regardless. The only real question Part B answers is whether this job, *in addition to* being wired into `qvac-merge-guard`, also needs its own independently-reported required check registered on the ruleset (rare in practice — `SDK Pod Checks` is **not** an example of this: it has a dual-trigger shape for branch coverage reasons, but the ruleset only requires `Check Approvals` and `qvac-merge-guard / validate-pr` today, nothing SDK-pod-specific — see Step 1 below).

## Part A — Wire the job into `qvac-merge-guard` (do this — it's not optional, not one of several options)

### Step 1 — Read the current job graph

Read `.github/workflows/pr-gate-merge.yml`, specifically the final `qvac-merge-guard` job's `needs:` list and the three `with:` booleans it passes to `public-pr.yml`. Read `docs/ci/MERGE-GUARD.md` for the diagram and worked examples.

Note: `sdk-pod-checks` reports under two check-context strings (`SDK Pod Checks` and `sdk-pod-checks / SDK Pod Checks`) — branch-coverage artifact, not a ruleset requirement. See the doc's "Gotcha" section.

### Step 2 — Ask the user which of the three patterns fits — do not silently infer it

**Present these three options as an explicit question and let the human pick.** Even if the repo state (an existing half-built caller workflow, an existing similar job, etc.) suggests one pattern, don't silently commit to it — surface the choice and its tradeoffs, then proceed with whichever the human confirms:

1. **Folds into an existing category** (another instance of a check already gated on, whatever its domain) — if matrix/filter-driven, add it to the `changes` job's `dorny/paths-filter` map; no other wiring needed. Otherwise add the job to an existing category's `needs:` and AND its result into that category's boolean expression.
2. **A repeated, growing family of similarly-shaped jobs** — more than one or two near-identical jobs differing only by target (one per package, one per platform, one per service, whatever naming pattern). **Only one target today? This is not your pattern — use 1 or 3 instead and wire the single job directly.** A caller workflow's value is dispatching to multiple targets from one place; building one for a single target is pure indirection. Refactor into a caller once a second target genuinely shows up.

   When there truly are multiple targets, **check matrix vs. caller before building anything** — this repo has both shapes for the same problem:
   - **Uniform job body across targets** (same composite action/steps, only e.g. `workdir` differs) → use a **matrix** like `sanity-checks` (`strategy.matrix.include: ...`). No caller workflow at all; the matrix job itself is what `qvac-merge-guard` depends on.
   - **Heterogeneous per-target jobs** (different `uses:`/inputs/secrets per target, or steps that genuinely diverge) → use a **caller workflow with one named job per target**, like `prebuilds-caller.yml`. This shape exists mainly for readability/separation, not because a matrix is technically impossible.

   Do **not** add each family member individually to `qvac-merge-guard`'s `needs:`. Whichever shape you land on (matrix or caller), wire only that one job/caller into `pr-gate-merge.yml`, and feed its result into `public-pr.yml`'s existing spare `integration-tests-status` input if unclaimed (don't invent a new one if a spare already fits).
3. **Genuinely new category** — a one-off job that isn't a repeated family and doesn't fit any existing boolean. Add the job, add it to `qvac-merge-guard`'s `needs:`, and either reuse `public-pr.yml`'s other spare input (`build-with-model-status`) or add a brand new boolean to both the `with:` block and `public-pr.yml`'s `workflow_call.inputs` + shell check block.

### Step 3 — Wire it, following the exact code shape in `docs/ci/MERGE-GUARD.md`

Copy the relevant snippet from the doc verbatim, substituting names. Do not invent a different `needs:`/`if:` shape from what's already established. If your new job's checks also need to run on branches Merge Guard doesn't cover (`pr-gate-merge.yml` is `main`-only), consider the two-trigger shape (own `pull_request`/`pull_request_target` + `workflow_call`) used by `pr-checks-sdk-pod.yml` — but understand upfront that produces two check-context strings for one piece of logic on `main`, and document both wherever the check is referenced by name.

### Step 4 — Validate

Because `pr-gate-merge.yml` is `pull_request_target`-triggered, it always runs the version on `main` — a PR editing this file cannot validate its own change pre-merge. Merge first, then open a follow-up PR against updated `main` and confirm via `gh pr checks <n> --repo tetherto/qvac` that `qvac-merge-guard / validate-pr` appears exactly once and reflects the new job's result (force it to fail once to prove the aggregate check goes red).

## Part B — Also registering it as an independent required check (additive, rare — skip by default)

Part A already happened regardless. This part only applies if the job *additionally* needs to be registered as its own required check **on the ruleset itself** — genuinely rare (today only `Check Approvals` and `qvac-merge-guard / validate-pr` are required; `SDK Pod Checks` is not, despite its dual-trigger shape — that shape is for branch coverage, covered in Step 1, not a ruleset requirement). Skip this section entirely unless you have a concrete reason the job needs to be independently required.

1. **Confirm the check-name string is unique across the repo first.** GitHub required-status-checks match by literal context string, no per-workflow scoping. Grep for job-id collisions (`grep -rl "^  <job-id>:$" .github/workflows/*.yml`) before requiring anything — a colliding legacy workflow can silently satisfy the requirement instead of the one you meant.
2. **Config lives in `github-ops`** (forked, fork-first — never edit `tetherto/github-ops` directly), managed by `octoops`. `qvac`'s ruleset config is in `qvac/repos.json` in that repo.
3. **Don't edit a shared preset directly** if other repos reference it (`check-approvals-gate-2-approvals` is shared by ~11 repos) — add a dedicated inline ruleset or override scoped to `qvac` only.
4. **`bypassActors` on a ruleset bypass every rule in that ruleset, not just the check you're adding.** If bypass actors are needed, put the new check in its **own dedicated ruleset** alongside the bypass actors, rather than adding both to an existing protection ruleset — verified empirically via the GitHub rule-suites audit log (`gh api repos/<org>/<repo>/rulesets/rule-suites`) that unrelated rulesets stay genuinely enforced, not bypassed.
5. **Only ever run `octoops apply --dry-run`** yourself. The real `octoops apply` (no `--dry-run`) mutates live ruleset state immediately and needs org-scoped token access — that's a human, out-of-band step, never run it as part of this skill.

For the full walkthrough (worked JSON, dry-run workaround for `runnerGroups` permission errors, verification checklist), see the `devops-add-required-status-check` skill in the `qvac-internal` repo — this section is the condensed, qvac-specific summary so this skill is self-contained without a cross-repo lookup for the common case.

## Verification checklist before calling this done

- [ ] Picked the right pattern (fold-in / caller-workflow / new-boolean) per Part A Step 2 — did not add a job to `needs:` with no aggregation for a repeated family.
- [ ] If a caller workflow was built, confirmed there are genuinely 2+ targets today — not built preemptively for a single target.
- [ ] No new top-level `pull_request_target` trigger with zero `needs:` link into `qvac-merge-guard` was created, unless Part B genuinely applies.
- [ ] Checked for a spare unused `public-pr.yml` input (`integration-tests-status`, `build-with-model-status`) before adding a new one.
- [ ] Validated post-merge (not pre-merge) that `qvac-merge-guard / validate-pr` reflects the new job — exactly one check name, no duplicate.
- [ ] If the new job has its own independent trigger in addition to being wired into `qvac-merge-guard`, confirmed and documented both resulting check-name strings (see the `sdk-pod-checks` gotcha) — no check-name regex/match written against only one of them.
- [ ] Confirmed Part A (folding into `qvac-merge-guard`) is done regardless — Part B is additive, not an alternative to it.
- [ ] If Part B applied: confirmed no check-name collision, didn't edit a shared preset, kept bypass actors on a dedicated ruleset, only ran `--dry-run`.
