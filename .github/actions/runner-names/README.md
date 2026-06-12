# Runner names

Canonical GitHub Actions runner labels for QVAC CI.

## Source of truth

Edit [`runners.yaml`](./runners.yaml) only, then regenerate dependents:

```bash
node .github/scripts/sync-runner-names.mjs
node .github/scripts/validate-runner-names.mjs
```

## Usage in workflows

Workflow-level `env` blocks are not used for runner labels. Instead, each workflow adds a reusable job that exports the labels once:

```yaml
jobs:
  runner_names:
    uses: ./.github/workflows/reusable-runner-names.yml

  lint:
    needs: runner_names
    runs-on: ${{ needs.runner_names.outputs.orch }}
```

Matrix jobs reference the same outputs:

```yaml
  integration:
    needs: runner_names
    strategy:
      matrix:
        include:
          - os: ${{ needs.runner_names.outputs.u22 }}
            runner: ${{ needs.runner_names.outputs.qvac_u22 }}
    runs-on: ${{ matrix.runner || matrix.os }}
```

Conditionals use the same namespace:

```yaml
if: matrix.os == needs.runner_names.outputs.u24_arm
```

When a job already depends on other jobs, prepend `runner_names` to `needs`:

```yaml
  publish:
    needs: [runner_names, build]
    runs-on: ${{ needs.runner_names.outputs.orch }}
```

## Output keys

| Key | Typical use |
| --- | --- |
| `orch` | Lightweight orchestration jobs (`ubuntu-latest`) |
| `u22`, `u24`, `u22_arm`, `u24_arm` | GitHub-hosted Linux matrix legs |
| `mac14`, `mac14_xl`, `mac15`, `mac15_intel`, `mac15_lg`, `mac15_xl` | GitHub-hosted macOS |
| `win22`, `win25` | GitHub-hosted Windows |
| `qvac_u22`, `qvac_u22_gpu`, `qvac_u24`, `qvac_u24_gpu` | Self-hosted QVAC Linux |
| `qvac_win25`, `qvac_win25_gpu` | Self-hosted QVAC Windows |
| `ai_linux`, `ai_linux_gpu`, `ai_u22`, `ai_win11_gpu` | Self-hosted AI benchmark runners |
| `gen_win11` | Windows 11 image builder |
| `mini_m4`, `mini_m4_gpu` | Mac mini lab runners |
| `lbl_*` | Benchmark/device labels (not always valid `runs-on` values) |

## Composite action

[action.yml](./action.yml) exposes the same keys as composite action outputs for jobs that already run `actions/checkout`. Callers should prefer `needs.runner_names.outputs.*` via the reusable workflow; use the composite action directly only when a job already has the repo checked out and cannot depend on `runner_names`.

## Why a reusable workflow?

GitHub evaluates `runs-on` and job matrices before any step runs, so a composite action cannot populate workflow env in time for those fields. The reusable workflow resolves labels in a tiny bootstrap job and exposes them as job outputs that downstream jobs can reference safely. The bootstrap job writes static values from `runners.yaml` directly to `GITHUB_OUTPUT` — no checkout required.
