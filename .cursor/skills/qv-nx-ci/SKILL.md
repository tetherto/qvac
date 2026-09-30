---
name: qv-nx-ci
description: Understand and modify the pnpm+Nx consolidated CI — the generic -nx.yml leaves driven by each package's project.json options.ci. Use when adding/changing a package's CI, onboarding a new package, generalising a bespoke per-package workflow into a leaf, editing the nx-project-matrix action or the on-pr-nx/on-merge-nx/prebuilds-nx/cpp-tests-nx/integration-test-nx leaves, or debugging why a package's CI stage did or didn't run.
---

# Nx CI — consolidated per-package workflows

Per-package CI is consolidated into generic `-nx.yml` leaves. Each package declares its CI shape as data in `packages/<pkg>/project.json` under `targets.<target>.options.ci`; Nx computes the affected set and `.github/actions/nx-project-matrix` turns each affected package's `options.ci` into a GitHub Actions matrix that the leaf fans out over.

Full reference (wiring diagram, options.ci cheat-sheet, fork-safety model): `docs/ci/nx-ci-consolidation.md`. Workspace/tooling primer (pnpm config, Nx affected graph, local commands): `docs/pnpm-nx-workspace.md`. **Read both first.**

## When to use

- Adding or changing a package's CI (prebuilds, cpp tests, integration, on-pr checks, benchmarks, on-merge publish).
- Onboarding a new package to the consolidated pipeline.
- Generalising a bespoke per-package workflow into a leaf.
- Editing `nx-project-matrix` or any `*-nx.yml` leaf.
- Debugging why a stage ran / didn't run for a package.

## Mental model: config is data, the leaf is generic

The matrix action flattens **every** field under `options.ci` into each matrix row generically (`{package, workdir, ...ci} + platform`). So a leaf reads a field as `${{ matrix.<field> }}` and a new field needs **no action change** — only the `project.json` (produce it) and the leaf step (consume it). Keep behaviour in data; touch a `.yml` only when a genuinely new step/shape is needed.

## Hard rules

1. **Config is read from the trusted default branch, never PR head.** `nx-project-matrix` does `git show <config-ref>:packages/<pkg>/project.json`, and on `pull_request_target` `config-ref` = `default_branch`. A new package's `project.json` must land on the default branch before its CI runs. Never "fix" a pre-merge red by reading config from head.
2. **Fork safety is non-negotiable.** `on-pr-nx.yml` is `pull_request_target` (base context, secrets). Base = control surface, head = code-under-test. Every privileged job has `fork-approval` first in `needs:` and gates on `authorize.outputs.allowed`. Never add a privileged job without both. Leaves build/test `github.event.pull_request.head.sha` — only after the gates pass.
3. **Mobile stays as `main`'s.** Do not consolidate `integration-mobile-test-<pkg>.yml` or add mobile to PRs beyond the existing asr/tts `coload-smoke-mobile` main-parity job. Never add `run-mobile-addon-tests` on PRs.
4. **`hasPrebuilds` is derived, not declared** — it is true iff `build.options.ci` exists. Don't add it by hand.
5. **Overrides are validated.** The action's `overrides` input can only set a field a package already declares — a PR cannot inject new CI behaviour. Keep it that way.
6. **Merge-gated jobs go through `qvac-merge-guard / validate-pr` only.** Never create a second required check. Use the `qv-merge-guard-wire` skill / `docs/ci/MERGE-GUARD.md`.
7. **Never delete/skip/weaken a test.** Fix the code or the config.

## Recipe A — change an existing package's CI (data-only)

1. Edit `packages/<pkg>/project.json` → `targets.<target>.options.ci`. Adjust the existing field (e.g. add a platform row to `test:cpp`, flip `includeVulkanSdk`, change a perf-report pattern).
2. Nothing else if the field is already consumed by the leaf. Validate (below).

## Recipe B — add a NEW options.ci field (data + one leaf step)

1. Add the field under the target's `options.ci` in the package(s) that need it. Others simply won't have it (matrix row omits it → `${{ matrix.<field> }}` is empty).
2. Consume it in the leaf: reference `${{ matrix.<field> }}` in the relevant step, or gate a step with `if: ${{ matrix.<field> }}`. For a whole flag-gated job, add a filtered sublist in the `matrix` job's `filter` step (jq `select(.<field> == true)`) and drive the job off `fromJSON(needs.matrix.outputs.<field>list)`.
3. Do **not** touch `nx-project-matrix` — pass-through is generic.

## Recipe C — onboard a new package

1. Add `packages/<pkg>/project.json` with the targets it needs (`build`, `on-pr`, `test:cpp`, `test:integration`, `benchmark`, `on-merge`) and their `options.ci`. Copy the closest existing package as a template.
2. Native addon: set `implicitDependencies: ["inference-addon-cpp", "lint-cpp"]` (and any real deps) so the graph and affected-detection are correct.
3. Land `project.json` on the default branch first (rule 1) — until then, dispatch the leaf with `config_ref_override` / `base-ref` pointed at your branch to test.

## Recipe D — generalise a bespoke per-package workflow into a leaf

The consolidation move: fold an `on-pr-<pkg>.yml` (or prebuilds/cpp/integration/on-merge twin) into the generic leaf.

1. **Diff the bespoke workflow against a package already folded.** What differs is either (a) a value → an `options.ci` field, or (b) a genuinely different step → a conditional step in the leaf.
2. **Decide fold vs carve-out:**
   - **Fold** when the flow is the leaf's shape with different values/toggles. Express every difference as `options.ci` fields (Recipe B) and delete the bespoke file.
   - **Carve-out** when steps genuinely diverge (bespoke integration/cpp flow, e.g. llm/asr/translation). Set `carveOut: true` on that target's `options.ci`, keep the bespoke reusable, and route to it from the orchestrator via the `carveouts` output (`if: contains(fromJSON(needs.matrix.outputs.carveouts), '<pkg>')`). The package still self-affects.
3. **Map, don't reinvent:** each bespoke `with:`/env/matrix value becomes an `options.ci` field consumed by the existing leaf step. Prefer widening an existing field over adding a near-duplicate.
4. **Delete the legacy file** in the same change (or the stacked cleanup PR) so PRs don't run two pipelines. Confirm nothing references it: `git grep <workflow-basename> .github/workflows`.
5. If the folded flow posts the `qvac/prebuild-<pkg>` status or gates the merge guard, confirm the producer/trust path (`scripts/prebuild-status/`) still holds.

## Validate before done

- `node .github/scripts/test/ci-trust-policy.test.mjs` — fork-safety + trusted-ref policy (must stay green).
- `node .github/scripts/test/prebuild-status.test.mjs` — if you touched prebuild-status trust.
- `actionlint <edited leaves>` — only pre-existing shellcheck style is acceptable.
- `pnpm exec nx show projects --affected -t <target> --base=<base> --head=<head>` — confirm the package set is what you expect.
- Standalone `gh workflow run <leaf>-nx.yml --ref <branch> -f base-ref=<x> -f head-ref=<y>` — prove the matrix resolves and the leaf runs.
- `git grep <deleted-workflow-basename> .github/workflows` returns nothing after a Recipe D deletion.
