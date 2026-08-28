# Self-hosted runners and workspace cleanup

QVAC CI uses a mix of **GitHub-hosted** runners (`ubuntu-*`, `macos-*`, `windows-*`) and **self-hosted** runners (labels such as `qvac-ubuntu2204-x64-gpu`, `qvac-win25-x64`). Self-hosted machines are persistent: the job workspace on disk can survive between runs unless it is cleared explicitly.

This document explains the **Manual Workspace Cleanup** step used at the start of many workflows, and why two fields are required on that step.

## Addon runner labels (QVAC-14347)

Specialized runner labels used by addon workflows (`cpp-tests-*`, `integration-test-*`, `integration-mobile-test-*`, `reusable-prebuilds.yml`, and related files) live in [`.github/runners.yaml`](../../.github/runners.yaml). `ubuntu-latest` orchestration jobs stay hardcoded.

GitHub evaluates `runs-on` and `strategy.matrix` before any step runs, so callers cannot read that YAML directly. A generated reusable workflow exports the labels as job outputs:

1. Edit [`.github/runners.yaml`](../../.github/runners.yaml).
2. Run `node .github/scripts/sync-runner-names.mjs` to regenerate [`.github/workflows/reusable-runner-names.yml`](../../.github/workflows/reusable-runner-names.yml). Do not hand-edit the reusable workflow.
3. Run `node --test .github/scripts/test/runner-names.test.mjs` (or `node .github/scripts/validate-runner-names.mjs`).
4. In addon workflows, add a bootstrap job and reference outputs instead of hardcoding labels:

```yaml
jobs:
  runner_names:
    permissions:
      contents: read
    uses: ./.github/workflows/reusable-runner-names.yml

  test-cpp:
    needs: runner_names
    runs-on: ${{ needs.runner_names.outputs.linux_ubuntu2404_x64 }}
```

The `runner_names` job declares an explicit least-privilege `permissions: contents: read` (every job must declare permissions; a reusable-calling job with no block inherits broad defaults and is flagged by the workflow-security audit).

Do **not** add `timeout-minutes:` to the `runner_names` caller job — GitHub forbids `timeout-minutes` on a job that calls a reusable workflow via `uses:` (actionlint: "when a reusable workflow is called with 'uses', 'timeout-minutes' is not available. only following keys are allowed: name, uses, with, secrets, needs, if, permissions"). The timeout is enforced inside the reusable, whose `export` job already sets `timeout-minutes: 5`.

Keep [`.github/actionlint.yaml`](../../.github/actionlint.yaml) in sync: every `qvac-*` label in the catalog must be listed there. Prefer `runner.environment` for cleanup gating so steps do not couple to `qvac-` prefixes.

### `os` is a frozen logical id, not a catalog label

The catalog governs only **where a job runs** — `runs-on:` and matrix `runner:`. It deliberately does **not** manage the `os:` matrix field, `matrix.os == '...'` step conditionals, or `"os":"..."` inside `fromJSON` matrices. `os` is a frozen logical identity: it names a matrix row, gates platform-specific steps (e.g. `if: matrix.os == 'macos-14'` in [`pr-test-inference-addon-cpp.yml`](../../.github/workflows/pr-test-inference-addon-cpp.yml)), and labels artifacts. Self-hosted rows intentionally pair a logical `os` with a different runner (e.g. `os: macos-14` + `runner: qvac-macos26-arm64-gpu`).

Because every catalog-label `os` row also carries an explicit `runner:` from the catalog, `runs-on` never falls back to `matrix.os`. So bumping a catalog label (e.g. `macos_arm64_gpu: qvac-macos26-arm64-gpu` → a new label) never requires touching any `os:` value, and re-imaging the logical `os` id (should the darwin fleet move off the `macos-14` string) is a separate, deliberate edit. `validate-runner-names.mjs` does not flag `os` for this reason. If you ever need `os` values that must track the runner, add an explicit `runner:` from the catalog to that row rather than relying on the `os` string.

### The `runner_names` bootstrap job runs unconditionally

Every wired workflow gains a `runner_names` job with no `if:` / `needs:` gate, so it runs on every PR event even when the consumer matrix is skipped (e.g. an unauthorized fork where `authorize` sets `allowed=false`). This is an accepted cost: the job is `ubuntu-latest`, has no checkout, and only echoes static label strings (~5s). Replicating each consumer's bespoke skip conditions (authorize gates, draft/label checks, CI-router outputs) onto the bootstrap across ~40 heterogeneous workflows would be high-churn and fragile for a job this cheap, and a skipped `runner_names` would cascade its `needs` consumers into skips anyway. Leave it ungated.

## Manual Workspace Cleanup

Several workflows begin with a step named **Manual Workspace Cleanup** that runs before `actions/checkout`:

```yaml
      - name: Manual Workspace Cleanup
        run: rm -rf "$GITHUB_WORKSPACE" && mkdir -p "$GITHUB_WORKSPACE"
        shell: bash
        working-directory: .
        if: runner.environment != 'github-hosted'
```

### Why this step exists

On self-hosted runners, leftover files from a previous job (failed run, cancelled run, or partial checkout) can pollute the next run. GitHub-hosted runners start from a fresh VM; self-hosted runners do not.

Deleting and recreating `$GITHUB_WORKSPACE` gives each job a clean tree before checkout, matching the isolation developers expect from hosted runners.

### `working-directory: .`

**Problem:** Many jobs set a default working directory at the job or workflow level, often `packages/<addon>/` via `env.WORKDIR` and per-step `working-directory: ${{ env.WORKDIR }}`. Step-level defaults are inherited unless overridden.

If Manual Workspace Cleanup does not set `working-directory`, the `run` script may execute under `packages/<addon>/` instead of the repository root. Then `rm -rf "$GITHUB_WORKSPACE"` still targets the correct path variable, but the step’s cwd is wrong, which has caused subtle cleanup failures and confusion when debugging paths.

**Fix:** Always set `working-directory: .` on this step so it runs at the repository root and overrides any job- or workflow-level default.

### `if: runner.environment != 'github-hosted'`

**Problem:** The cleanup is only needed on self-hosted runners. Running it on GitHub-hosted runners adds latency and is unnecessary.

Historically, workflows used `if: startsWith(matrix.runner, 'qvac-')` or `if: startsWith(matrix.os, 'qvac-')`. That couples behavior to label naming, breaks when a matrix row uses a hosted label (for example `ubuntu-22.04-arm`) alongside `qvac-*` rows, and must be updated whenever runner labels change.

**Fix:** Use GitHub’s runner metadata:

```yaml
if: runner.environment != 'github-hosted'
```

This is true for self-hosted runners regardless of the matrix label string, and false for GitHub-hosted runners including `macos-14` and `ubuntu-*` matrix entries.

**When to omit `if`:** Only when the job **always** runs on self-hosted runners (no hosted matrix rows). Example: a job that only uses `qvac-*` labels and never `ubuntu-latest` / `macos-*` hosted labels. If the job is mixed, keep the `if`.

**When the step is absent:** Some workflows were refactored (for example mobile integration flows that checkout sparse paths first) and no longer use Manual Workspace Cleanup. Do not add the step unless the job checks out the full repo on a persistent self-hosted runner at `$GITHUB_WORKSPACE`.

## Related patterns

### Model cache on self-hosted runners

The composite action [`.github/actions/cache-models`](../../.github/actions/cache-models/action.yml) should be gated the same way:

```yaml
if: runner.environment != 'github-hosted'
```

Self-hosted runners use a transparent local cache; hosted runners should use normal download paths.

### Setup steps that only apply on hosted runners

The inverse condition is also common:

```yaml
if: runner.environment == 'github-hosted'
```

Example: [`.github/workflows/cpp-tests-classification.yml`](../../.github/workflows/cpp-tests-classification.yml) runs **Setup build host** only on GitHub-hosted runners.

## Checklist when adding or editing workflows

1. If the job uses self-hosted runners and checks out the default workspace, add **Manual Workspace Cleanup** as the first step (before checkout).
2. Include `working-directory: .` on that step.
3. Include `if: runner.environment != 'github-hosted'` when the matrix mixes hosted and self-hosted runners.
4. Prefer `runner.environment` over `startsWith(matrix.runner, 'qvac-')` for any self-hosted-only step.
5. Addon jobs that need a specialized runner must take the label from `needs.runner_names.outputs.*` (see [Addon runner labels](#addon-runner-labels-qvac-14347)). Do not hardcode `qvac-*`, `macos-14`, or other catalog labels.

## See also

- [`.cursor/rules/devops/github-actions.mdc`](../../.cursor/rules/devops/github-actions.mdc) — Cursor rule for workflow authors
- [`packages/ocr-ggml/.agent/knowledge/ci-validation.md`](../../packages/ocr-ggml/.agent/knowledge/ci-validation.md) — agent knowledge for CI troubleshooting
- [`docs/ci/LABELS.md`](LABELS.md) — PR label gating
- [`docs/ci/TEAMS.md`](TEAMS.md) — who can apply privileged labels
