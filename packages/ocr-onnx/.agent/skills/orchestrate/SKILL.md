---
name: orchestrate
description: Run the full plan review (can be skipped) → implement → test → CI → review → PR pipeline for a task. Coordinates plan-reviewer, implementer, test-writer, ci-validator, and code-reviewer agents.
argument-hint: "[--no-plan] <asana-task-id-or-url | description | file-path-or-url>"
disable-model-invocation: true
---

# Orchestrate: Full Task Pipeline

Run the complete agent pipeline for a task: branch setup, plan review, implement, test, CI validate, review, push, and create PR.

## Usage

`/orchestrate [--no-plan] <input>`

Accepts three input types:

| Input | Example | Detection |
|-------|---------|-----------|
| Asana task URL | `https://app.asana.com/0/.../1213560067347874` | Contains `app.asana.com` |
| Asana task ID | `1213560067347874` | All digits, 10+ characters |
| Markdown file | `./plan.md` or `https://raw.githubusercontent.com/.../plan.md` | Ends with `.md` (no spaces), or non-Asana `https://` URL |
| Text description | `Add retry logic to the OCR pipeline with exponential backoff` | Everything else |

Detection rules are checked in the order shown. A non-Asana URL (e.g., GitHub raw link) is treated as a file to fetch, not a description.

The `--no-plan` flag skips Phase 0.5 (Plan Review) entirely. Phase 1 receives the task description directly as the plan context.

When no Asana task is linked (`file` or `description` mode), Asana-specific operations (reading the task, commenting, marking complete) are skipped automatically. The pipeline produces the same outputs (branch, commits, PR) regardless of input source.

## Pipeline

### Phase 0: Setup

1. **Parse the input** and classify it using the detection rules from the Usage section. Strip `--no-plan` if present.

2. **Build the task context** — a normalized set of fields consumed by all downstream phases:

   | Field | Asana mode | File mode | Description mode |
   |-------|-----------|-----------|-----------------|
   | `inputMode` | `"asana"` | `"file"` | `"description"` |
   | `taskId` | The Asana task ID | `null` | `null` |
   | `title` | From Asana task name | First `# heading` in file, or filename slug | First ~80 chars of input, truncated at word boundary |
   | `description` | Task description + acceptance criteria | Full file contents | Full input text |
   | `ticketNumber` | From task name or custom field (e.g., `QVAC-123`) | `null` | `null` |
   | `source` | `"Asana task <id>"` | `"File: <path-or-url>"` | `"Inline description"` |

   How to populate:
   - **Asana mode**: Read the Asana task via MCP to get title, description, acceptance criteria, tags, and custom fields. Extract `ticketNumber` from the task name or a custom field.
   - **File mode**: Read the file (local path → filesystem read; remote URL → fetch). Extract `title` from the first `# heading` in the file. If no heading exists, slugify the filename (e.g., `add-rag-support.md` → `add rag support`).
   - **Description mode**: Use the full input text as `description`. Extract `title` from the first ~80 characters, truncated at a word boundary.

3. **Create a feature branch** from main:
   - Pull latest main: `git checkout main && git pull origin main`
   - Generate branch name from task context:
     - If `ticketNumber` is present: `feat/<ticket>-<slug>` (e.g., `feat/QVAC-123-add-rag-support-for-lancedb`)
     - Otherwise: `feat/<title-slug>` (e.g., `feat/add-retry-logic-to-ocr-pipeline`)
     - Slugify: lowercase, hyphens, max 50 chars
   - Create and switch to branch: `git checkout -b <branch-name>`

4. **Determine if planning is needed:**

   | Signal | Planning needed? |
   |--------|-----------------|
   | Task has implementation requirements (code changes, new features, bug fixes) | Yes |
   | Task is documentation-only, config-only, or CI-only | No — skip to Phase 1 |
   | Task description says "no plan needed" or equivalent | No — skip to Phase 1 |
   | User passed `--no-plan` flag to `/orchestrate` | No — skip to Phase 1 |

   **When planning is skipped**: Phase 1 (Implement) receives the task `description` directly as the plan context. The instructions change to: `"Implement the following task. No plan was created — work directly from the task description and acceptance criteria."` (include `Task ID: <taskId>` only when `inputMode` is `asana`).

5. **Inform the user** of the setup:
   ```
   Task: <title>
   Source: <source>
   Branch: <branch-name>
   ```

### Phase 0.5: Plan Review

Before any implementation, create a plan, have it reviewed, and get user approval:

1. **Read the relevant source files** mentioned in the task description or likely affected by the changes
2. **Draft an initial implementation plan** that includes:
   - Summary of what will be changed and why
   - Files to create or modify (with brief description of changes per file)
   - Approach and key design decisions
   - Dependencies or packages to add (if any)
   - How it will be verified (build commands, test commands)
3. **Launch plan-reviewer(s):**
   a. Check `roles` → `plan-reviewer` assignment in `.agent/config.json`
   b. **If unassigned** (not in `roles`, or `roles` is empty): launch plan-reviewer locally on the orchestrating tool (single review). After the agent completes, parse its output to extract `verdict`, `questions`, and `recommendations` (extract `### Verdict`, `### Questions`, `### Recommendations` from the structured output into a `review` object). If `### Verdict` is missing, default to `NEEDS_CLARIFICATION`.
   c. **If string (single tool)**: dispatch to that tool (local or handoff, following standard role dispatch rules). If local, apply the same post-execution parsing as step 3b.
   d. **If array (multiple tools)**: dispatch to ALL listed tools in parallel:
      - For each tool in the array, write a separate handoff request: `.agent-handoff/plan-review-<tool>-request.json`
      - Auto-invoke CLI-capable tools; prompt for non-CLI tools
      - Poll for ALL result files simultaneously: for each tool in the array, poll for `.agent-handoff/plan-review-<tool>-result.json`
4. **Collect reviews:**
   a. **Single reviewer**: read the review, proceed to step 5
   b. **Multiple reviewers**: wait for ALL reviewers to complete, then apply verdict precedence (`REQUEST_CHANGES` > `NEEDS_CLARIFICATION` > `APPROVE`):
      - Collect all `Verdict` fields from the `review` object in each result
      - If ANY verdict is `REQUEST_CHANGES`: present all recommendations and any NEEDS_CLARIFICATION questions together to the user. Incorporate feedback into the plan, re-run ALL reviewers with the updated plan (and answers to questions, if any)
      - Else if ANY verdict is `NEEDS_CLARIFICATION` (and none are REQUEST_CHANGES): present the questions to the user, get answers, re-run only the reviewer(s) that had questions (with answers as additional context)
      - Else ALL verdicts are `APPROVE`: if any reviewer included non-empty Recommendations, run step 5 to incorporate them before proceeding to step 6. If no recommendations, proceed directly to step 6
      - Maximum 5 review rounds before stopping and asking the user to decide
      - **Cleanup between rounds**: before writing new request files for a re-review round, delete all handoff files from the previous round: for each tool, delete `plan-review-<tool>-{request,heartbeat,result,cli.log}`. Same pattern as retry file lifecycle.
      - **Cleanup after consensus**: after final verdicts are collected (all APPROVE or round limit hit), delete all remaining multi-reviewer handoff files before proceeding.
5. **Incorporate feedback**: update the plan based on reviewer recommendations (orchestrator does this locally — reviewers don't modify the plan themselves)
6. **Present the final plan to the user** for approval:
   - Show the plan with a summary of reviewer feedback
   - If multiple reviewers: show consensus status ("All reviewers approved" or "Reviewers agreed after N rounds")
   - Wait for user approval. If the user requests changes, update the plan and optionally re-run reviewers
   - Do NOT proceed until the user explicitly approves
7. **If `inputMode` is `asana`**: comment on the Asana task with the approved plan and reviewer summaries

### Phase 1: Implement

Launch the **implementer** agent with the task context **and the approved plan**.

```
Implement the following task. Follow this approved plan:

<paste the approved plan here>

Task context:
- Source: <source>
- Title: <title>
- Description: <description>
<if inputMode is asana: "Task ID: <taskId>" — otherwise omit>

Write code within scope of the plan, verify build/tests pass, and commit working changes.
```

Wait for completion. If the implementer reports failure (e.g., ambiguous requirements, build failures after 3 retries), stop the pipeline and report to the user.

### Phase 1.5: Determine test and CI requirements

After implementation, analyze the changed files and the task description to decide what's needed next.

Run `git diff --name-only main...HEAD` and apply these rules:

1. **Native addon packages** — if changed files match a package in the **CI Package Mapping** table in `.agent/knowledge/ci-validation.md`, CI is needed. Use the short name from that table. If multiple addon packages changed, run CI for each.

2. **SDK / TS packages** (`packages/qvac-sdk/**`, `packages/rag/**`, `packages/cli/**`) — SDK CI runs automatically via `pr-checks-sdk-pod` on PR creation. No manual trigger needed.

3. **Everything else** (simple libraries, docs, workflows, config, markdown) — no CI needed.

If CI is needed, inform the user which packages will be validated and why.

**Determine if new tests are needed** by checking:

| Signal | Tests needed? |
|---|---|
| New public API / exported functions added | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Task description/acceptance criteria mention testable behavior | Yes |
| Refactoring with no behavior change | No |
| Documentation / config / CI workflow only | No |
| Changes already have corresponding test updates from implementer | No — skip |

Read the task description and acceptance criteria (from the task context `description` field). If they describe specific behaviors or scenarios, those should become tests.

### Phase 1.75: Write Tests

If Phase 1.5 determined tests are needed, launch the **test-writer** agent:

```
Write automated tests for the changes on the current branch.
Task: <title>
<if inputMode is asana: "Task ID: <taskId>." — otherwise omit>
Focus on new public APIs, new behavior, and edge cases. Match existing test patterns.
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
Review all changes on the current branch against main.
Task: <title>
<if inputMode is asana: "Task ID: <taskId>." — otherwise omit>
Check requirements match, bugs, conventions, security, scope, and test coverage. Fix issues directly and commit fixes.
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
   - **Title**: If `ticketNumber` is present: `<ticket> <prefix>[tags]: <title-summary>`. Otherwise: `<prefix>[tags]: <title-summary>` (following commit format from CLAUDE.md)
   - **Body**: Generate based on PR type:
     - For addon packages: follow the format from `/addon-pr-description`
     - For SDK packages: follow the format from `/sdk-pr-create`
     - Include: what changed, why, test plan
     - If `inputMode` is `asana`: include link to Asana task
     - Otherwise: include `Source: <source>` in the PR body
   - **Base**: `main`
   - Examples:
     ```bash
     gh pr create --base main --title "QVAC-123 feat: add RAG support" --body "..."
     gh pr create --base main --title "feat: add retry logic to OCR pipeline" --body "..."
     ```

4. **If `inputMode` is `asana`**: link the PR to the Asana task by commenting on the task with the PR URL.

### Phase 6: Report

Produce a final summary:

```
Pipeline complete for: <title> (<source>)

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

If `inputMode` is `asana`:
- Add the final summary as a comment on the Asana task
- If all phases passed, mark the task as complete

## Error handling

- If implementer fails: report what went wrong and stop
- If CI fails after 2 implement→CI loops: report the persistent failure and stop
- If reviewer finds architectural concerns: report them and stop
- If PR creation fails: report the error, the branch is still pushed
- At any stop point, if `inputMode` is `asana`, comment on the Asana task with current status

## Role Dispatch

Before running the pipeline, check if `.agent/config.json` exists and has a `roles` section.

- If no config or no roles: all phases run locally (__TOOL_IDENTITY__ handles everything)
- If roles are configured: validate assignments against tool capabilities, warn on mismatches

### Capability validation at startup

Read `.agent/config.json` and check each role assignment against the assigned tool's capabilities. Warn (do not block) on these soft mismatches:

| Agent | Soft requirement | Degradation |
|---|---|---|
| Any agent that updates Asana | `mcp` | Agent cannot read/write Asana during execution — orchestrator proxies updates from result file |
| implementer, code-reviewer, plan-reviewer | `modelSelection` | Runs on default model instead of Opus; may produce lower-quality output |
| ci-validator | `loopPolling` | Falls back to `gh run watch`; functional but less integrated |
| All | `namedAgents` | Prompt-based launch instead of named; works but loses agent-specific context loading |
| ci-validator, model-registry-updater | `persistentMemory` | Learnings lost between sessions; no workaround |

There are no hard blocks — the handoff protocol covers all roles.

### Phase dispatch rules

| Phase | Agent | Dispatch |
|-------|-------|----------|
| 0 (Setup) | — | Always local (orchestrator) |
| 0.5 (Plan Review) | plan-reviewer | Check roles (supports array assignment for multi-reviewer) |
| 1 (Implement) | implementer | Check roles |
| 1.75 (Test) | test-writer | Check roles |
| 2 (CI) | ci-validator | Check roles |
| 3 (Review) | code-reviewer | Check roles |
| 4 (Re-validate) | ci-validator | Check roles |
| 5 (PR) | — | Always local (orchestrator) |
| 6 (Report) | — | Always local (orchestrator) |

### For each role-checked phase

**If role assigned to __TOOL_IDENTITY__ (or unassigned):**
Launch agent locally, as today.

**If role assigned to a different tool:**

1. Commit and push any pending changes so the other tool has them
2. Write `.agent-handoff/<phase>-request.json` with full context:
   ```json
   {
     "phase": "<phase-name>",
     "agent": "<agent-name>",
     "assignedTo": "<tool-key>",
     "taskId": "<asana-task-id-or-null>",
     "taskContext": {
       "inputMode": "asana|file|description",
       "title": "<task title>",
       "description": "<full task description>",
       "source": "<human-readable source label>"
     },
     "branch": "<current-branch>",
     "context": {
       "plan": "<approved plan text>",
       "changedFiles": ["<list of changed files>"],
       "previousPhaseResult": "<summary from previous phase>"
     },
     "instructions": "<agent instructions with task context>",
     "status": "pending",
     "createdAt": "<ISO timestamp>"
   }
   ```
   For retries, include `retryCount` and `retryReason` fields.
3. **Auto-invoke or manual fallback:**
   a. Read the target tool's `cli` field from `.agent/config.json`
   b. **If `cli` is configured** (not null): optionally verify `command -v <cli.command>` to catch "tool not installed." Fire `<cli.command> <cli.args...> "Run /handoff to pick up pending inter-tool handoff requests."` in the background, capturing output to `.agent-handoff/<phase>-cli.log`. Log prominently: *"AUTO-INVOKING [tool] CLI for Phase N ([agent]). Polling for result... Do NOT run /handoff manually."*
   c. **If `cli` is null**: tell the user: *"Phase N (agent) is assigned to [tool]. Run `/handoff` in your [tool] session."*
4. Poll for `.agent-handoff/<phase>-result.json` every 10 seconds
5. While polling, check the heartbeat file and apply adaptive staleness thresholds:
   - `"Starting"`, `"Checking out"`, `"Pulling"` → stale after 2 minutes
   - `"Agent running"` → stale after 30 minutes
   - `"Pushing"` → stale after 5 minutes
   - `"Writing result"` → stale after 2 minutes
   - Any other message → stale after 5 minutes (default)
   - Warn at 1x threshold, offer local fallback at 2x
   - **Auto-invoked tools** (no heartbeat ever written): warn after 2 min, offer fallback after 5 min
   - **Manual fallback tools** (no heartbeat ever written): remind user after 5 min, offer fallback after 15 min
   - **Absolute wall-clock timeout**: Regardless of heartbeat activity, offer local fallback after 60 minutes from request creation. This catches runaway agents that remain active but never complete.
6. On result: pull latest commits, read result, clean up all handoff files for that phase (request, heartbeat, result, `<phase>-cli.log`), continue pipeline
7. On failure result: handle same as local agent failure (retry logic, Asana update if `inputMode` is `asana`, stop)

### Asana proxy for handed-off phases

**Only applies when `inputMode` is `asana`.** When no Asana task is linked, skip the proxy entirely.

When a phase was executed by a tool without MCP (`mcp: false` in config), the orchestrator proxies Asana updates immediately after reading the handoff result:

1. Read the result `summary` field
2. Write an Asana comment: `[<agent-name> via <tool>]: <summary>`
3. If the result had errors, include them in the Asana comment

Skip the proxy if the receiving tool has `mcp: true` — it is expected to have written its own Asana comments directly.

### Cross-tool retry handling

When roles are split across tools, retry loops create cross-tool handoff cycles. The existing max-2-retry limit applies regardless of which tools are involved. Before writing a retry request for the same phase:

1. Read and consume the previous result file
2. Delete the previous result + heartbeat + request files
3. Write the new request with incremented `retryCount` and `retryReason`

## Important notes

- Phase 0 creates the branch automatically — user does not need to set up anything
- When `inputMode` is `asana`, the skill asks for confirmation before marking the Asana task complete
- Each agent runs in isolation with fresh context
- The pipeline can be resumed manually if interrupted — just re-run from the failed phase
