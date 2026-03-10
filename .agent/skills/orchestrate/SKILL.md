---
name: orchestrate
description: Run the full implement → CI → review pipeline for a task. Coordinates implementer, ci-validator, and code-reviewer agents.
argument-hint: "<asana-task-id>"
disable-model-invocation: true
---

# Orchestrate: Full Task Pipeline

Run the complete agent pipeline for a task: implement, validate on CI, review, and re-validate.

## Usage

`/orchestrate <asana-task-id>`

## Pipeline

### Phase 1: Implement

Launch the **implementer** agent with the Asana task ID.

```
Implement Asana task $ARGUMENTS. Read the task, understand requirements, write code within scope, verify build/tests pass, and commit working changes. Do not push.
```

Wait for completion. If the implementer reports failure (e.g., ambiguous requirements, build failures after 3 retries), stop the pipeline and report to the user.

### Phase 1.5: Determine CI requirements

After implementation, analyze the changed files to decide if cross-platform CI validation is needed.

Run `git diff --name-only main...HEAD` and apply these rules:

| Changed files | CI needed? | Package |
|---|---|---|
| `packages/qvac-lib-infer-llamacpp-llm/**` | Yes | `LLM` |
| `packages/qvac-lib-infer-llamacpp-embed/**` | Yes | `Embed` |
| `packages/ocr-onnx/**` | Yes | `OCR` |
| `packages/qvac-lib-infer-onnx-tts/**` | Yes | `TTS` |
| `packages/qvac-lib-infer-whispercpp/**` | Yes | `Whispercpp` |
| `packages/qvac-lib-infer-parakeet/**` | Yes | `Parakeet` |
| `packages/qvac-lib-infer-nmtcpp/**` | Yes | `NMTCPP` |
| `packages/qvac-lib-decoder-audio/**` | Yes | `Decoder-audio` |
| `packages/qvac-sdk/**` (TS only) | No | — |
| `packages/docs/**` | No | — |
| `.github/workflows/**` only | No | — |
| `*.md` only | No | — |
| Config/tooling files only | No | — |

If multiple native addon packages changed, run CI for each affected package.

If CI is needed, inform the user which packages will be validated and why.

### Phase 2: CI Validation

If Phase 1.5 determined CI is needed:

1. Push the current branch: `git push origin HEAD`
2. Launch the **ci-validator** agent for each affected package
3. If CI fails with **code errors**: go back to Phase 1 — launch implementer again with the error details
4. If CI fails with **infra errors**: let ci-validator handle retries
5. Maximum 2 implement→CI loops before stopping

If CI is not needed, skip to Phase 3.

### Phase 3: Review

Launch the **code-reviewer** agent:

```
Review all changes on the current branch against main. Task ID: $ARGUMENTS. Check requirements match, bugs, conventions, security, scope, and test coverage. Fix issues directly and commit fixes.
```

Wait for completion. Collect the review summary.

### Phase 4: Re-validate (if reviewer made fixes)

If the reviewer committed any fixes AND Phase 1.5 determined CI was needed:
1. Re-run CI validation for the affected packages
2. If CI passes, proceed to reporting

If no CI needed or no reviewer fixes, proceed to reporting.

### Phase 5: Report

Produce a final summary:

```
Pipeline complete for task $ARGUMENTS:

Implementation:
  - [summary from implementer]
  - Files changed: [list]

CI Validation:
  - [pass/fail/skipped]
  - Packages tested: [list or "n/a — no native addon changes"]
  - Platforms: [list]

Review:
  - Issues found and fixed: [count]
  - Issues flagged but not fixed: [count, with details]

Status: [ready to push / needs attention]
```

If all phases passed, ask the user: "Push to remote and update Asana task status?"

## Error handling

- If implementer fails: report what went wrong and stop
- If CI fails after 2 implement→CI loops: report the persistent failure and stop
- If reviewer finds architectural concerns: report them and stop
- At any stop point, comment on the Asana task with current status

## Important notes

- This skill coordinates agents but does NOT push code or update task status without user confirmation
- Each agent runs in isolation with fresh context
- The pipeline can be resumed manually if interrupted — just re-run from the failed phase
