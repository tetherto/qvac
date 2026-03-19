---
name: handoff
description: Pick up and execute delegated phases from another tool via the inter-tool handoff protocol
argument-hint: "[--tool=<name>]"
disable-model-invocation: true
---

# Handoff: Inter-Tool Phase Receiver

Pick up pending handoff requests assigned to this tool and execute them.

## Usage

`/handoff`

Scans `.agent-handoff/` for pending requests assigned to this tool, executes each one, and writes result files for the orchestrator to consume.

Optional: `/handoff --tool=<name>` to override tool identity (for tools without a `setup_<tool>()` function yet).

## Workflow

### Step 1: Scan for pending requests

1. Check if `.agent-handoff/` directory exists at the repo root. If not, report "No handoff directory found" and stop.
2. List all `*-request.json` files in `.agent-handoff/`
3. Filter to requests where:
   - `status` is `"pending"` (skip `"running"` — another instance may be processing it)
   - `assignedTo` matches __TOOL_IDENTITY__
4. Filter out stale requests: ignore any request file older than **1 hour** with no corresponding heartbeat file
5. Clean orphaned result files: delete any `*-result.json` file with `completedAt` older than **1 hour** (these are from CLIs that completed after the orchestrator crashed). Log a warning with the result's `summary` field so the user can see what the orphaned process accomplished.
6. If no matching requests found, report "No pending handoffs for this tool" and stop
7. Sort matching requests by phase order: `plan-review`, `implement`, `test`, `ci`, `review`, `revalidate`

### Step 2: Process each request

For each matching request (in phase order):

#### 2a. Read and claim the request

1. Read the request JSON file
2. Derive the **file prefix** from the request filename by stripping `-request.json` (e.g., `plan-review-claude-request.json` → prefix `plan-review-claude`; `implement-request.json` → prefix `implement`). Use this prefix for all derived filenames (heartbeat, result) instead of the `phase` field.
3. Update the request's `status` field to `"running"` (write back to the same file)
4. Write initial heartbeat file (`<prefix>-heartbeat.json`):
   ```json
   {
     "phase": "<phase>",
     "status": "running",
     "message": "Starting",
     "updatedAt": "<current ISO timestamp>"
   }
   ```

#### 2b. Prepare the workspace

1. Update heartbeat: `"message": "Checking out branch"`
2. Check out the task branch: `git checkout <branch>` (from the request's `branch` field)
3. Update heartbeat: `"message": "Pulling latest changes"`
4. Pull latest: `git pull origin <branch>`

#### 2c. Launch the agent

1. Update heartbeat: `"message": "Agent running — <agent-name>"`
2. Read the agent definition from `.agent/agents/<agent>.md`
3. **Before starting, read and follow the agent conduct rules in `.agent/conduct.md`.**
4. Launch the agent with the request's `instructions` and `context`:

   **Claude Code**: Launch the named agent directly:
   ```
   Launch the <agent> agent with these instructions:
   <instructions from request>

   Context:
   <context from request>
   ```

   **Cursor**: Read `.cursor/rules/agents/<agent>.mdc` and pass the prompt to `Task(subagent_type="generalPurpose")`:
   ```
   <agent prompt from .mdc file>

   Instructions: <instructions from request>

   Context:
   <context from request>
   ```

   **Other tools (generic fallback)**: Read `.agent/agents/<agent>.md`, strip frontmatter, and use as the agent prompt along with instructions and context.

5. Wait for agent completion

#### 2d. Push results

1. Update heartbeat: `"message": "Pushing commits"`
2. Push commits to remote: `git push origin <branch>`
3. If push fails:
   - Collect commit hashes from the local branch (commits since the request's base)
   - Write a failure result (see step 2e) with error type `"push_failure"` and `retryable: true`
   - Include the commit hashes in the result so the orchestrator knows work was done
   - Delete the heartbeat file (result supersedes it)
   - Skip to the next request

#### 2e. Write result

1. Update heartbeat: `"message": "Writing result"`
2. Collect:
   - Commit hashes added during agent execution
   - Agent's summary of what was done
   - Any errors encountered
3. Write `<prefix>-result.json`:

   **On success:**
   ```json
   {
     "phase": "<phase>",
     "status": "success",
     "summary": "<agent's summary of work done>",
     "commits": ["<hash1>", "<hash2>"],
     "errors": [],
     "completedAt": "<current ISO timestamp>"
   }
   ```

   **On failure:**
   ```json
   {
     "phase": "<phase>",
     "status": "failure",
     "summary": "<what was attempted>",
     "commits": ["<any commits made before failure>"],
     "errors": [
       {
         "type": "<error_type>",
         "message": "<human-readable error message>",
         "details": "<full error output>",
         "retryable": true
       }
     ],
     "completedAt": "<current ISO timestamp>"
   }
   ```

   **For `plan-review` phase**: Parse the agent's structured output to extract the `review` object and add it to the result JSON:
   - Extract `### Verdict` → `review.verdict` (must be one of `APPROVE`, `REQUEST_CHANGES`, `NEEDS_CLARIFICATION`)
   - Extract bullets under `### Questions` → `review.questions` (array of strings)
   - Extract bullets under `### Recommendations` → `review.recommendations` (array of strings)
   - If `### Verdict` is missing from the agent output, default to `NEEDS_CLARIFICATION`

   ```json
   {
     "phase": "plan-review",
     "status": "success",
     "summary": "<full review markdown text>",
     "commits": [],
     "errors": [],
     "completedAt": "<current ISO timestamp>",
     "review": {
       "verdict": "REQUEST_CHANGES",
       "questions": ["<clarifying question>"],
       "recommendations": ["<specific suggestion>"]
     }
   }
   ```

4. Delete the heartbeat file (result supersedes it)

### Step 3: Report

After processing all requests, report to the user:
- How many requests were processed
- Phase name and agent for each
- Status (success/failure) and brief summary for each
- Any errors encountered

## Error Types

| Type | Meaning | Retryable? |
|------|---------|------------|
| `build_failure` | Build command failed | Yes |
| `test_failure` | Tests failed | Yes |
| `lint_failure` | Lint checks failed | Yes |
| `push_failure` | Git push to remote failed | Yes |
| `agent_crash` | Agent stopped unexpectedly | Yes |
| `checkout_failure` | Could not check out the branch | No |
| `requirements_unclear` | Agent flagged ambiguous requirements | No |

## Retry Requests

If a request has `retryCount` > 0, it is a retry of a previously failed phase. The `retryReason` field contains the previous failure details. Pass this context to the agent so it can focus on fixing the specific issue.

## Important Notes

- **Atomic file writes**: Write result files to a temp file first, then rename to the final path. This prevents the orchestrator from reading a partial file.
- **One at a time**: Process requests sequentially in phase order, not in parallel. Each phase may depend on the previous one's output.
- **Don't modify request files** beyond updating `status` to `"running"`. The orchestrator owns the request format.
- **Branch safety**: Always pull before starting work and push after completing. The orchestrator expects commits to be on the remote.
