---
name: review
description: Run a comprehensive code review with 4 specialized reviewers (security, correctness, performance, consistency) in parallel.
argument-hint: "[PR#|branch] [--only security|correctness|performance|consistency]"
---

# Code Review

Run a comprehensive code review using 4 specialized review agents: security, correctness, performance, and consistency.

## Usage

```
/review              # review current branch changes vs main
/review #1561        # review a PR by number
/review branch-name  # review a specific branch vs main
/review --only security,correctness  # run only specific reviewers
```

## Arguments

- No argument: review current branch changes against `main`
- `#<number>` or `<number>`: review a GitHub PR
- `<branch-name>`: review a specific branch against `main`
- `--only <list>`: comma-separated list of reviewers to run (security, correctness, performance, consistency). Default: all 4.

## Workflow

### Step 1: Determine review target

Parse `$ARGUMENTS` to determine the review target:

- If argument starts with `#` or is a number → PR review mode
- If argument is a branch name → branch review mode
- If no argument → current branch review mode

Extract `--only` flag if present to filter which reviewers to launch.

### Step 2: Get the diff

**PR review mode:**
```bash
gh pr diff <number> --repo tetherto/qvac
gh pr view <number> --repo tetherto/qvac --json title,body,commits
```

**Branch review mode:**
```bash
git diff main...<branch>
git log main..<branch> --oneline
```

**Current branch mode:**
```bash
git diff main...HEAD
git log main..HEAD --oneline
```

If the diff is empty, report "No changes to review" and stop.

### Step 3: Launch specialized reviewers in parallel

Launch the selected review agents **in parallel** as sub-agents.

For each agent, set:
- `subagent_type` to the reviewer name
- `model: "sonnet"` to keep review costs down (Claude Code only — Cursor CLI inherits the parent model)
- `readonly: true` (reviewers report only — they must not modify files)
- `prompt` with enough context for the sub-agent to work independently (see template below)

**Agents to launch** (all 4 unless `--only` filters):

1. **security-reviewer** — injection, auth bypass, credential exposure, OWASP patterns
2. **correctness-reviewer** — logic bugs, edge cases, race conditions, test coverage
3. **performance-reviewer** — allocations, blocking calls, memory leaks, N+1
4. **consistency-reviewer** — cross-addon pattern enforcement, architecture alignment

**Prompt template** — adapt `[target]`, `[diff-command]`, and `[domain]` for each reviewer:

```
Review the code changes on [target] in repo tetherto/qvac.
To get the diff, run: [diff-command]
Focus only on [domain] issues.
Report each finding with: severity, file path and line, description, impact, and fix recommendation.
If no issues found, report: "No [domain] issues identified."
Do NOT fix code — report findings only.
```

Where `[diff-command]` is:
- PR mode: `gh pr diff <number> --repo tetherto/qvac`
- Branch mode: `git diff main...<branch>`
- Current branch mode: `git diff main...HEAD`

### Step 4: Check for forbidden files

While reviewers run, do a quick check:
- `.npmrc`, `.env`, or credential files must NOT be in the diff
- If found, warn immediately

### Step 5: Collect and present results

Collect results from all reviewers and present a unified report:

```
## Code Review: [target]

### Security
[findings or "No issues"]

### Correctness
[findings or "No issues"]

### Performance
[findings or "No issues"]

### Consistency
[findings or "No issues"]

### Summary
- Total findings: X (Y critical, Z warnings)
- Recommendation: [ready to merge / needs fixes / needs discussion]
```

### Step 6: Offer to fix

After presenting the report, ask the user:

```
Found X issues. Want me to fix the actionable ones? (y/n)
```

If the user says yes:
1. Fix each actionable issue directly
2. Commit each fix: `fix: [description]`
3. Re-run build/tests to verify
4. Report what was fixed

Do NOT fix:
- Performance suggestions requiring architectural changes
- Consistency deviations that may be intentional
- Anything marked as "needs discussion"

## Notes

- All 4 reviewers run in parallel via sub-agents for speed
- On Claude Code, set `model: "sonnet"` on each Agent tool call to keep costs down
- On Cursor CLI, reviewers inherit the parent model (no model override available)
- The skill itself coordinates and synthesizes — it does not duplicate reviewer work
- Does NOT push to remote — the user handles that
