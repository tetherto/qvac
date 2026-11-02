---
name: orchestrate
description: Run the full implement → test → CI → review → PR pipeline for a task. Coordinates implementer, test-writer, ci-validator, and code-reviewer agents.
argument-hint: "<task-description-or-local-file>"
disable-model-invocation: true
---

# Orchestrate: Full Task Pipeline

Run the complete agent pipeline for a task: branch setup, implement, test, CI validate, review, push, and create PR.

## Usage

`/orchestrate <task-description-or-local-file>`

Accept a task description in chat or a path to a local requirements file. Include the title, acceptance criteria, file scope, and ticket reference if known.

## Pipeline

### Phase 0: Setup

1. Read the task requirements supplied in chat or a local file.
2. Identify the title, acceptance criteria, file scope, and ticket reference.

3. **Create a feature branch** from main:
   - Pull latest main: `git checkout main && git pull origin main`
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
   ```

### Phase 0.5: Plan

Before any implementation, create a plan for the user to approve:

1. **Read the relevant source files** mentioned in the task description or likely affected by the changes
2. **Draft an implementation plan** that includes:
   - Summary of what will be changed and why
   - Files to create or modify (with brief description of changes per file)
   - Approach and key design decisions
   - Dependencies or packages to add (if any)
   - How it will be verified (build commands, test commands)
3. **Present the plan to the user** and wait for approval
   - If the user requests changes, update the plan and ask again
   - Do NOT proceed until the user explicitly approves

### Phase 1: Implement

Launch the **implementer** agent with the supplied requirements **and the approved plan**.

```
Implement the supplied task requirements. Follow this approved plan:

<paste the approved plan here>

Write code within scope of the plan, verify build/tests pass, and commit working changes.
```

Wait for completion. If the implementer reports failure (e.g., ambiguous requirements, build failures after 3 retries), stop the pipeline and report to the user.

### Phase 1.5: Determine test and CI requirements

After implementation, analyze the changed files and the supplied requirements to decide what's needed next.

Run `git diff --name-only main...HEAD` and apply these rules:

1. **Native addon packages** — if changed files match a package in the **CI Package Mapping** table in `.agent/knowledge/ci-validation.md`, CI is needed. Use the short name from that table. If multiple addon packages changed, run CI for each.

2. **SDK / TS packages** (`packages/sdk/**`, `packages/rag/**`, `packages/cli/**`) — SDK CI runs automatically via `pr-checks-sdk-pod` on PR creation. No manual trigger needed.

3. **Everything else** (simple libraries, docs, workflows, config, markdown) — no CI needed.

If CI is needed, inform the user which packages will be validated and why.

**Determine if new tests are needed** by checking:

| Signal | Tests needed? |
|---|---|
| New public API / exported functions added | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Supplied task acceptance criteria mention testable behavior | Yes |
| Refactoring with no behavior change | No |
| Documentation / config / CI workflow only | No |
| Changes already have corresponding test updates from implementer | No — skip |

Read the supplied task acceptance criteria. If they describe specific behaviors or scenarios, those should become tests.

### Phase 1.75: Write Tests

If Phase 1.5 determined tests are needed, launch the **test-writer** agent:

```
Write automated tests for the changes on the current branch. Task requirements: <supplied requirements>. Focus on new public APIs, new behavior, and edge cases. Match existing test patterns.
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
Review all changes on the current branch against main. Task requirements: <supplied requirements>. Check requirements match, bugs, conventions, security, scope, and test coverage. Fix issues directly and commit fixes.
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
   - If changes are in `packages/sdk/` or other TS packages → SDK PR
   - If changes are in native addon packages → Addon PR
   - If mixed → use addon format (more detailed)

3. **Create the PR** using `gh pr create`:
   - **Title**: `<ticket> <prefix>[tags]: <task-title-summary>` (following commit format from CLAUDE.md)
   - **Body**: Generate based on PR type:
     - For addon packages: follow the format from `/qv-addon-pr-create`
     - For SDK packages: follow the format from `/qv-sdk-pr-create`
     - Include: what changed, why, test plan, task reference supplied by the user, if any
   - **Base**: `main`
   - Example:
     ```bash
     gh pr create --base main --title "QVAC-123 feat: add RAG support" --body "..."
     ```

4. Report the PR URL in chat.

### Phase 6: Report

Produce a final summary:

```
Pipeline complete for task <task-title>:

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

Present the final summary and completion status in chat.

## Error handling

- If implementer fails: report what went wrong and stop
- If CI fails after 2 implement→CI loops: report the persistent failure and stop
- If reviewer finds architectural concerns: report them and stop
- If PR creation fails: report the error, the branch is still pushed
- At any stop point, report the current status in chat

## Important notes

- Phase 0 creates the branch automatically — user does not need to set up anything
- Each agent runs in isolation with fresh context
- The pipeline can be resumed manually if interrupted — just re-run from the failed phase
