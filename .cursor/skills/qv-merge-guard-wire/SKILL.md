---
name: qv-merge-guard-wire
description: Wire a new CI job/workflow into the qvac-merge-guard / validate-pr aggregated required status check, instead of it becoming a disconnected standalone check
disable-model-invocation: true
---

# Merge Guard Wire — hook a new job into the required status check

`qvac-merge-guard / validate-pr` is the **single** required status check on `main`. Adding a new CI job without wiring it into this aggregate creates a second, disconnected check the branch ruleset never requires — its failures become invisible. This skill is the checklist for wiring a job into the existing aggregate correctly.

Full reference with diagrams and worked examples: `docs/ci/MERGE-GUARD.md`.

## When to use

- Adding **any** new job/workflow that should block merges — regardless of domain (addon package check, SDK check, docs validation, security scan, licensing gate, anything).
- A PR review flags a new job that isn't reflected in `qvac-merge-guard`'s pass/fail.

## Hard rule: nothing but `pr-gate-merge.yml` may produce the `qvac-merge-guard / validate-pr` check name

```bash
grep -rl "^  qvac-merge-guard:$" .github/workflows/*.yml
```

Must return **only** `pr-gate-merge.yml`. If any other file has a job id `qvac-merge-guard` (or a job calling a reusable workflow whose job id is `validate-pr`), that's a collision — it would silently satisfy the required check without going through the real gate. Fix before doing anything else in this skill.

## Step 1 — Read the current job graph

Read `.github/workflows/pr-gate-merge.yml`, specifically the final `qvac-merge-guard` job's `needs:` list and the three `with:` booleans it passes to `public-pr.yml`. Read `docs/ci/MERGE-GUARD.md` for the diagram and worked examples.

Note: `sdk-pod-checks` reports under two check-context strings (`SDK Pod Checks` and `sdk-pod-checks / SDK Pod Checks`) — branch-coverage artifact, not a ruleset requirement. See the doc's "Gotcha" section.

## Step 2 — Ask the user which of the three patterns fits — do not silently infer it

**Present these three options as an explicit question and let the human pick.** Even if the repo state (an existing half-built caller workflow, an existing similar job, etc.) suggests one pattern, don't silently commit to it — surface the choice and its tradeoffs, then proceed with whichever the human confirms:

1. **Folds into an existing category** (another instance of a check already gated on, whatever its domain) — if matrix/filter-driven, add it to the `changes` job's `dorny/paths-filter` map; no other wiring needed. Otherwise add the job to an existing category's `needs:` and AND its result into that category's boolean expression.
2. **A repeated, growing family of similarly-shaped jobs** — more than one or two near-identical jobs differing only by target (one per package, one per platform, one per service, whatever naming pattern). **Only one target today? This is not your pattern — use 1 or 3 instead and wire the single job directly.** A caller workflow's value is dispatching to multiple targets from one place; building one for a single target is pure indirection. Refactor into a caller once a second target genuinely shows up.

   When there truly are multiple targets, **check matrix vs. caller before building anything** — this repo has both shapes for the same problem:
   - **Uniform job body across targets** (same composite action/steps, only e.g. `workdir` differs) → use a **matrix** like `sanity-checks` (`strategy.matrix.include: ...`). No caller workflow at all; the matrix job itself is what `qvac-merge-guard` depends on.
   - **Heterogeneous per-target jobs** (different `uses:`/inputs/secrets per target, or steps that genuinely diverge) → use a **caller workflow with one named job per target**, like `prebuilds-caller.yml`. This shape exists mainly for readability/separation, not because a matrix is technically impossible.

   Do **not** add each family member individually to `qvac-merge-guard`'s `needs:`. Whichever shape you land on (matrix or caller), wire only that one job/caller into `pr-gate-merge.yml`, and feed its result into `public-pr.yml`'s existing spare `integration-tests-status` input if unclaimed (don't invent a new one if a spare already fits).
3. **Genuinely new category** — a one-off job that isn't a repeated family and doesn't fit any existing boolean. Add the job, add it to `qvac-merge-guard`'s `needs:`, and either reuse `public-pr.yml`'s other spare input (`build-with-model-status`) or add a brand new boolean to both the `with:` block and `public-pr.yml`'s `workflow_call.inputs` + shell check block.

## Step 3 — Wire it, following the exact code shape in `docs/ci/MERGE-GUARD.md`

Copy the relevant snippet from the doc verbatim, substituting names. Do not invent a different `needs:`/`if:` shape from what's already established. If your new job's checks also need to run on branches Merge Guard doesn't cover (`pr-gate-merge.yml` is `main`-only), consider the two-trigger shape (own `pull_request`/`pull_request_target` + `workflow_call`) used by `pr-checks-sdk-pod.yml` — but understand upfront that produces two check-context strings for one piece of logic on `main`, and document both wherever the check is referenced by name.

## Step 4 — Validate

Because `pr-gate-merge.yml` is `pull_request_target`-triggered, it always runs the version on `main` — a PR editing this file cannot validate its own change pre-merge. Merge first, then open a follow-up PR against updated `main` and confirm via `gh pr checks <n> --repo tetherto/qvac` that `qvac-merge-guard / validate-pr` appears exactly once and reflects the new job's result (force it to fail once to prove the aggregate check goes red).

## Verification checklist before calling this done

- [ ] Confirmed `grep -rl "^  qvac-merge-guard:$" .github/workflows/*.yml` returns only `pr-gate-merge.yml` — no other workflow produces the `qvac-merge-guard / validate-pr` check name.
- [ ] Picked the right pattern (fold-in / caller-workflow / new-boolean) per Step 2 — did not add a job to `needs:` with no aggregation for a repeated family.
- [ ] If a caller workflow was built, confirmed there are genuinely 2+ targets today — not built preemptively for a single target.
- [ ] No new top-level `pull_request_target` trigger with zero `needs:` link into `qvac-merge-guard` was created.
- [ ] Checked for a spare unused `public-pr.yml` input (`integration-tests-status`, `build-with-model-status`) before adding a new one.
- [ ] Validated post-merge (not pre-merge) that `qvac-merge-guard / validate-pr` reflects the new job — exactly one check name, no duplicate.
- [ ] If the new job has its own independent trigger in addition to being wired into `qvac-merge-guard`, confirmed and documented both resulting check-name strings (see the `sdk-pod-checks` gotcha) — no check-name regex/match written against only one of them.
