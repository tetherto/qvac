---
name: orchestrate
description: Run the full implement → test → CI → review → PR pipeline for a task. Coordinates implementer, test-writer, ci-validator, and code-reviewer agents.
argument-hint: "<asana-task-id-or-url>"
disable-model-invocation: true
---

# Orchestrate: Full Task Pipeline

Run the complete agent pipeline for a task: branch setup, implement, test, CI validate, review, push, and create PR.

## Usage

`/orchestrate <asana-task-id-or-url>`

Accepts either:
- Asana task ID: `1213560067347874`
- Asana URL: `https://app.asana.com/0/1234567890/1213560067347874`

## Pipeline

### Phase 0: Setup

1. **Parse the Asana task ID** from the argument:
   - If it's a URL, extract the last numeric segment as the task ID
   - If it's already a numeric ID, use it directly

2. **Read the Asana task** to get:
   - Task title
   - Task description and acceptance criteria
   - Any tags or custom fields (e.g., package name, ticket number)

3. **Create a feature branch** from `temp-agent-first`:
   - Pull latest: `git checkout temp-agent-first && git pull origin temp-agent-first`
   - Generate branch name from task: `feat/<ticket>-<slug>`
     - Extract ticket number from task name or custom field (e.g., `QVAC-123`)
     - Slugify the task title (lowercase, hyphens, max 50 chars)
     - Example: `feat/QVAC-123-add-rag-support-for-lancedb`
   - If no ticket number found: `feat/<task-title-slug>`
   - Create and switch to branch: `git checkout -b <branch-name>`

4. **Inform the user** of the setup:
   ```
   Task: <task-title>
   Branch: <branch-name>
   Starting implementation...
   ```

### Phase 1: Implement

Launch the **implementer** agent with the Asana task ID.

```
Implement Asana task <task-id>. Read the task, understand requirements, write code within scope, verify build/tests pass, and commit working changes. Do not push.
```

Wait for completion. If the implementer reports failure (e.g., ambiguous requirements, build failures after 3 retries), stop the pipeline and report to the user.

### Phase 1.5: Determine test and CI requirements

After implementation, analyze the changed files and the Asana task to decide what's needed next.

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

**Determine if new tests are needed** by checking:

| Signal | Tests needed? |
|---|---|
| New public API / exported functions added | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Asana task acceptance criteria mention testable behavior | Yes |
| Refactoring with no behavior change | No |
| Documentation / config / CI workflow only | No |
| Changes already have corresponding test updates from implementer | No — skip |

Read the Asana task acceptance criteria. If they describe specific behaviors or scenarios, those should become tests.

### Phase 1.75: Write Tests

If Phase 1.5 determined tests are needed, launch the **test-writer** agent:

```
Write automated tests for the changes on the current branch. Task ID: <task-id>. Focus on new public APIs, new behavior, and edge cases. Match existing test patterns.
```

Wait for completion. If the test-writer discovers code bugs, launch the implementer again with the bug details before proceeding.

If tests are not needed, skip to Phase 2.

### Phase 2: CI Validation

If Phase 1.5 determined CI is needed:

1. Push the current branch: `git push -u origin HEAD`
2. Launch the **ci-validator** agent for each affected package
3. If CI fails with **code errors**: go back to Phase 1 — launch implementer again with the error details
4. If CI fails with **infra errors**: let ci-validator handle retries
5. Maximum 2 implement→CI loops before stopping

If CI is not needed, skip to Phase 3.

### Phase 3: Review

Launch the **code-reviewer** agent:

```
Review all changes on the current branch against main. Task ID: <task-id>. Check requirements match, bugs, conventions, security, scope, and test coverage. Fix issues directly and commit fixes.
```

Wait for completion. Collect the review summary.

### Phase 4: Re-validate (if reviewer made fixes)

If the reviewer committed any fixes AND Phase 1.5 determined CI was needed:
1. Re-run CI validation for the affected packages
2. If CI passes, proceed to reporting

If no CI needed or no reviewer fixes, proceed to reporting.

### Phase 5: Push and Create PR

1. **Push** the branch to origin:
   ```bash
   git push -u origin HEAD
   ```

2. **Determine PR type** from the changed files:
   - If changes are in `packages/qvac-sdk/` or other TS packages → SDK PR
   - If changes are in native addon packages → Addon PR
   - If mixed → use addon format (more detailed)

3. **Create the PR** using `gh pr create`:
   - **Title**: `<ticket> <prefix>[tags]: <task-title-summary>` (following commit format from CLAUDE.md)
   - **Body**: Generate based on PR type:
     - For addon packages: follow the format from `/addon-pr-description`
     - For SDK packages: follow the format from `/sdk-pr-create`
     - Include: what changed, why, test plan, link to Asana task
   - **Base**: `main`
   - Example:
     ```bash
     gh pr create --base main --title "QVAC-123 feat: add RAG support" --body "..."
     ```

4. **Link the PR to the Asana task**: comment on the task with the PR URL.

### Phase 6: Report

Produce a final summary:

```
Pipeline complete for task <task-id>:

Branch: <branch-name>
PR: <pr-url>

Implementation:
  - [summary from implementer]
  - Files changed: [list]

Tests:
  - [added/skipped, with reason]
  - Tests added: [count and brief descriptions]
  - Code bugs found by tests: [count or none]

CI Validation:
  - [pass/fail/skipped]
  - Packages tested: [list or "n/a — no native addon changes"]
  - Platforms: [list]

Review:
  - Issues found and fixed: [count]
  - Issues flagged but not fixed: [count, with details]

Status: [ready for human review / needs attention]
```

Update the Asana task:
- Add the final summary as a comment
- If all phases passed, mark the task as complete

## Error handling

- If implementer fails: report what went wrong and stop
- If CI fails after 2 implement→CI loops: report the persistent failure and stop
- If reviewer finds architectural concerns: report them and stop
- If PR creation fails: report the error, the branch is still pushed
- At any stop point, comment on the Asana task with current status

## Important notes

- Phase 0 creates the branch automatically — user does not need to set up anything
- The skill asks for confirmation before marking the Asana task complete
- Each agent runs in isolation with fresh context
- The pipeline can be resumed manually if interrupted — just re-run from the failed phase
