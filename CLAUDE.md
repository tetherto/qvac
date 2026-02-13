# Workflow Audit & Gitflow Fixes

Branch: `fix_gitflow_implementation_on_missing_workflows`

## Gitflow Model

| Branch | Registry | Tag | Publish Action |
|--------|----------|-----|----------------|
| `main` | GPR (`@tetherto`) | `dev` | `publish-library-to-gpr` |
| `release-*` | NPM (`@qvac`) | `latest` | `publish-library-to-npm` |
| `feature-*` | GPR | `feature` | `publish-library-to-gpr` |
| `tmp-*` | GPR | `temp` | `publish-library-to-gpr` |

- Composite actions live in `tetherto/qvac-devops` (`@monorepo_update` ref), mirrored locally in `.github/actions/` for reference only.
- `publish-library-to-gpr` and `publish-library-to-npm` both output `npm_published_version` as their step output name. Job-level outputs remap this to `published_version`.

## Fixes Applied

### 1. On-Merge Rewrites (TTS & OCR)
- **on-merge-qvac-lib-infer-onnx-tts.yml** - Rewritten from legacy to modern gitflow (publish-logic, 4 branch types, workflow_dispatch, GitHub release, integration + mobile tests).
- **on-merge-qvac-lib-inference-addon-onnx-ocr-fasttext.yml** - Same rewrite. Does NOT pass `repository`/`ref` to prebuilds (OCR prebuilds defaults to `tetherto/qvac`).

### 2. Prebuilds Double-Triggering (Push Triggers Removed)
Removed overlapping `push` triggers from 4 prebuilds workflows. They should only have `workflow_call` + `workflow_dispatch`:
- `prebuilds-qvac-lib-infer-nmtcpp.yml`
- `prebuilds-qvac-lib-infer-onnx-tts.yml`
- `prebuilds-qvac-lib-inference-addon-onnx-ocr-fasttext.yml`
- `prebuilds-qvac-lib-infer-onnx-vad.yml`

### 3. VAD Prebuilds Completeness
**prebuilds-qvac-lib-infer-onnx-vad.yml**:
- Added `publish_target` input to `workflow_call`
- Added `published_version` workflow output
- Added `outputs` block and `id: publish` to `publish-gpr` job

### 4. LLM Prebuilds Output Chain
**prebuilds-qvac-lib-infer-llamacpp-llm.yml**:
- Renamed job-level output keys from `npm_published_version` to `published_version` (in both `publish-gpr` and `publish-npm` jobs)
- Updated workflow output to reference `jobs.*.outputs.published_version`

### 5. `github.base_ref` Fix
`github.base_ref` is only available for `pull_request` events, NOT `pull_request_target`. Fixed in:
- `on-pr-qvac-lib-infer-llamacpp-embed.yml` (line 30)
- `on-pr-qvac-lib-infer-llamacpp-llm.yml` (line 31)
- `on-pr-qvac-lib-infer-whispercpp.yml` (line 35)

Changed `startsWith(github.base_ref, 'release-')` to `startsWith(github.event.pull_request.base.ref, 'release-')`.

### 6. release-pr-guard `isGreater()` Fix
**`.github/actions/release-pr-guard/src/index.ts`** and **`dist/index.js`**:
- Original compared version arrays with `>` (lexicographic string comparison).
- Fixed to component-wise numeric comparison loop.

### 7. Verify Label Gating (`pull_request_target` Security)
Added `verify` label requirement to all `pull_request_target` workflows that execute PR code:

| File | Pattern Used |
|------|-------------|
| `on-pr-qvac-lib-decoder-audio.yml` | Direct `contains()` check |
| `on-pr-qvac-lib-infer-onnx-tts.yml` | Context job resolves `run_verify` |
| `on-pr-qvac-lib-infer-onnx-vad.yml` | Context job resolves `run_verify` |
| `on-pr-qvac-lib-infer-whispercpp.yml` | Direct `contains()` check |
| `on-pr-qvac-lib-infer-llamacpp-embed.yml` | Direct `contains()` check |
| `on-pr-qvac-lib-infer-llamacpp-llm.yml` | Direct `contains()` check |
| `on-pr-qvac-lib-inference-addon-onnx-ocr-fasttext.yml` | `format()` + `contains()` |
| `on-pr-qvac-lib-infer-nmtcpp.yml` | `contains()` + changes filter |
| `pr-test-qvac-lib-inference-addon-cpp.yml` | Direct `contains()` check |
| `pr-models-validation-qvac-lib-registry-server.yml` | Direct `contains()` on `validate-json` and `test` jobs |

### 8. pr-models-validation Ungated Execution
**pr-models-validation-qvac-lib-registry-server.yml**: Added `verify` label gate to `validate-json` and `test` jobs which checkout and execute PR head code with secrets.

## Known Pre-existing Issues (Out of Scope)

These existed before this branch and were not introduced by our changes. The user confirmed: "You can ignore missing workflows. It is just as it was in source repos."

### On-Merge Gaps
- **embed/llm** (`on-merge-qvac-lib-infer-llamacpp-{embed,llm}.yml`): Missing prebuild gate, integration tests, mobile tests. `workflow_dispatch` tag input only has `latest`/`dev` (missing `feature`/`temp`). `publish-logic` doesn't read `inputs.tag`.
- **nmtcpp** (`on-merge-qvac-lib-infer-nmtcpp.yml`): Uses `prebuild-*` job naming instead of `publish-*`. Missing mobile-integration-tests job. Has `check-version-change` + `create-github-release` pattern (different from others).
- **decoder-audio** (`on-merge-qvac-lib-decoder-audio.yml`): Uses monolithic publish pattern (direct GPR/NPM publish) instead of prebuilds workflow. Architecturally different but functional.
- **Inconsistent tag override**: whispercpp uses explicit `github.event.inputs.tag` check; decoder-audio/nmtcpp use `INPUT_TAG` env var; others don't handle it in `publish-logic` at all.

### On-PR Gaps
- `release-notes-check` jobs in decoder-audio and whispercpp run without verify label gate (read-only, low risk).
- `pr-test-qvac-lib-inference-addon-cpp.yml` missing `branches: [main, release-*]` filter on `pull_request_target`.
- `pr-validation-sdk-pod.yml` uses bare `actions/checkout@v4` without `ref` for PR head (validates base branch code instead of PR code).
- Inconsistent merge-guard skipped-state handling across on-pr files.

### On-PR-Close Gaps
- `on-pr-close-qvac-lib-infer-nmtcpp.yml` missing `pull_request: [closed]` trigger (only has `workflow_dispatch`).
- Missing on-pr-close workflows for `decoder-audio` and `onnx-tts`.

### Style Inconsistencies
- `secrets.pat_token` (lowercase) in 4 dispatch workflows (functionally equivalent due to GitHub case-insensitivity).
- Missing `release-notes-check` workflows for onnx-tts, nmtcpp, onnx-vad.

## Output Variable Chain (Reference)

```
Composite Action step  -->  Job output  -->  Workflow output
npm_published_version      published_version   published_version
```

The composite actions (`publish-library-to-gpr`, `publish-library-to-npm`) output `npm_published_version`. Job-level outputs map: `published_version: ${{ steps.publish.outputs.npm_published_version }}`. Downstream consumers reference `jobs.*.outputs.published_version`.

Exception: whispercpp prebuilds uses a custom `capture_version` step instead of `id: publish`.

## Files Modified (19 files)

```
.github/actions/release-pr-guard/src/index.ts
.github/actions/release-pr-guard/dist/index.js
.github/workflows/on-merge-qvac-lib-infer-onnx-tts.yml
.github/workflows/on-merge-qvac-lib-inference-addon-onnx-ocr-fasttext.yml
.github/workflows/prebuilds-qvac-lib-infer-nmtcpp.yml
.github/workflows/prebuilds-qvac-lib-infer-onnx-tts.yml
.github/workflows/prebuilds-qvac-lib-inference-addon-onnx-ocr-fasttext.yml
.github/workflows/prebuilds-qvac-lib-infer-onnx-vad.yml
.github/workflows/prebuilds-qvac-lib-infer-llamacpp-llm.yml
.github/workflows/on-pr-qvac-lib-decoder-audio.yml
.github/workflows/on-pr-qvac-lib-infer-onnx-tts.yml
.github/workflows/on-pr-qvac-lib-infer-onnx-vad.yml
.github/workflows/on-pr-qvac-lib-inference-addon-onnx-ocr-fasttext.yml
.github/workflows/on-pr-qvac-lib-infer-nmtcpp.yml
.github/workflows/on-pr-qvac-lib-infer-whispercpp.yml
.github/workflows/on-pr-qvac-lib-infer-llamacpp-embed.yml
.github/workflows/on-pr-qvac-lib-infer-llamacpp-llm.yml
.github/workflows/pr-test-qvac-lib-inference-addon-cpp.yml
.github/workflows/pr-models-validation-qvac-lib-registry-server.yml
```
