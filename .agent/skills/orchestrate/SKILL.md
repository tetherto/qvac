---
name: orchestrate
description: Run the full implement → CI → review pipeline for a task. Coordinates implementer, ci-validator, and code-reviewer agents.
argument-hint: "<asana-task-id> [package-short-name]"
disable-model-invocation: true
---

# Orchestrate: Full Task Pipeline

Run the complete agent pipeline for a task: implement, validate on CI, review, and re-validate.

## Usage

`/orchestrate <asana-task-id> [package-short-name]`

- `asana-task-id` — The Asana task ID to implement
- `package-short-name` — Optional. CI package name (LLM, OCR, TTS, etc.) for cross-platform validation. If omitted, CI validation is skipped.

## Pipeline

### Phase 1: Implement

Launch the **implementer** agent with the Asana task ID.

```
Implement Asana task $ARGUMENTS[0]. Read the task, understand requirements, write code within scope, verify build/tests pass, and commit working changes. Do not push.
```

Wait for completion. If the implementer reports failure (e.g., ambiguous requirements, build failures after 3 retries), stop the pipeline and report to the user.

### Phase 2: CI Validation (optional)

If a package short name was provided (`$ARGUMENTS[1]`), launch the **ci-validator** agent:

1. Push the current branch: `git push origin HEAD`
2. Launch ci-validator to trigger and monitor the CI pipeline for the package
3. If CI fails with **code errors**: go back to Phase 1 — launch implementer again with the error details
4. If CI fails with **infra errors**: let ci-validator handle retries
5. Maximum 2 implement→CI loops before stopping

If no package name was provided, skip to Phase 3.

### Phase 3: Review

Launch the **code-reviewer** agent:

```
Review all changes on the current branch against main. Task ID: $ARGUMENTS[0]. Check requirements match, bugs, conventions, security, scope, and test coverage. Fix issues directly and commit fixes.
```

Wait for completion. Collect the review summary.

### Phase 4: Re-validate (if reviewer made fixes)

If the reviewer committed any fixes:
1. If a package short name was provided, re-run CI validation (Phase 2)
2. If CI passes or no package name, proceed to reporting

### Phase 5: Report

Produce a final summary:

```
Pipeline complete for task $ARGUMENTS[0]:

Implementation:
  - [summary from implementer]

CI Validation:
  - [pass/fail/skipped, platforms tested]

Review:
  - [issues found and fixed]
  - [issues flagged but not fixed]

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
