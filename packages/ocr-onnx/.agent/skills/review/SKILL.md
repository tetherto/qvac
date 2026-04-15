---
name: review
description: Run a comprehensive code review with 4 specialized reviewers (security, correctness, performance, consistency) in parallel.
argument-hint: "[PR#|branch] [--only security|correctness|performance|consistency]"
---

# Code Review

Run a comprehensive code review using 4 specialized review agents in parallel: security, correctness, performance, and consistency.

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

Launch the selected review agents **in parallel** using the Agent tool. Each agent gets the same context.

For each agent, use `subagent_type` matching the agent name and include in the prompt:
- The review mode (PR number or branch name)
- The repository: `tetherto/qvac`
- Instruction to report findings in its standard format

**Agents to launch** (all 4 unless `--only` filters):

1. **security-reviewer**: "Review the code changes on [target] in repo tetherto/qvac. Focus only on security issues. Report findings in your standard format."

2. **correctness-reviewer**: "Review the code changes on [target] in repo tetherto/qvac. Focus only on correctness issues. Report findings in your standard format."

3. **performance-reviewer**: "Review the code changes on [target] in repo tetherto/qvac. Focus only on performance issues. Report findings in your standard format."

4. **consistency-reviewer**: "Review the code changes on [target] in repo tetherto/qvac. Focus only on consistency and architecture issues. Report findings in your standard format."

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

- All 4 reviewers run in parallel for speed
- Each reviewer uses the sonnet model to keep costs down
- The skill itself coordinates and synthesizes — it does not duplicate reviewer work
- Does NOT push to remote — the user handles that
