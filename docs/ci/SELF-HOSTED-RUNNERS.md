# Self-hosted runners and workspace cleanup

QVAC CI uses a mix of **GitHub-hosted** runners (`ubuntu-*`, `macos-*`, `windows-*`) and **self-hosted** runners (labels such as `qvac-ubuntu2204-x64-gpu`, `qvac-win25-x64`). Self-hosted machines are persistent: the job workspace on disk can survive between runs unless it is cleared explicitly.

This document explains the **Manual Workspace Cleanup** step used at the start of many workflows, and why two fields are required on that step.

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

## See also

- [`.cursor/rules/devops/github-actions.mdc`](../../.cursor/rules/devops/github-actions.mdc) — Cursor rule for workflow authors
- [`packages/ocr-onnx/.agent/knowledge/ci-validation.md`](../../packages/ocr-onnx/.agent/knowledge/ci-validation.md) — agent knowledge for CI troubleshooting
- [`docs/ci/LABELS.md`](LABELS.md) — PR label gating
- [`docs/ci/TEAMS.md`](TEAMS.md) — who can apply privileged labels
