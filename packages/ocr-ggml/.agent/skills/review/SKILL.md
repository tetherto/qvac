---
name: review
description: Run a comprehensive code review with 4 specialized reviewers (security, correctness, performance, consistency) in parallel.
argument-hint: "[PR#|branch] [--only security|correctness|performance|consistency] [--depth standard|max]"
---

# Code Review

Run a comprehensive code review using 4 specialized review agents: security, correctness, performance, and consistency.

## Usage

```
/review              # review current branch changes vs main
/review #1561        # review a PR by number
/review branch-name  # review a specific branch vs main
/review --only security,correctness  # run only specific reviewers
/review #1561 --depth max            # maximum-depth pass (every reviewer on the session model)
```

## Arguments

- No argument: review current branch changes against `main`
- `#<number>` or `<number>`: review a GitHub PR
- `<branch-name>`: review a specific branch against `main`
- `--only <list>`: comma-separated list of reviewers to run (security, correctness, performance, consistency). Default: all 4.
- `--depth <standard|max>`: review depth. `standard` uses the per-reviewer default models (see Step 3). `max` runs a maximum-depth pass: all reviewers on the **session model** — the model this session is itself running on, which is the strongest model the review is allowed to use — unless `review.maxDepthModel` pins an explicit model. Default comes from `review.depth` in `packages/ocr-ggml/.agent/config.json` (falls back to `standard` if absent); the flag overrides the config.

## Workflow

### Step 1: Determine review target

Parse `$ARGUMENTS` to determine the review target:

- If argument starts with `#` or is a number → PR review mode
- If argument is a branch name → branch review mode
- If no argument → current branch review mode

Extract `--only` flag if present to filter which reviewers to launch.

Extract `--depth` flag if present. If absent, read `review.depth` from `packages/ocr-ggml/.agent/config.json`; if the file or field is missing, use `standard`.

Determine the **session model family** — the model this session is itself running on — from the session's own model identity (Claude Code states it in context, e.g. "powered by the model named Opus 5", exact ID `claude-opus-5[1m]` → family `opus`). Map it to one of `haiku`, `sonnet`, `opus`, `fable`. If it cannot be determined, skip the clamping in Step 3 and use the table defaults as-is.

### Step 2: Get the diff

**PR review mode:**
```bash
gh pr diff <number> --repo tetherto/qvac
gh pr view <number> --repo tetherto/qvac --json title,body,commits,headRefOid,headRefName,baseRefName
```

**Branch review mode:**
```bash
git diff main...<branch>
git log main..<branch> --oneline
git rev-parse <branch>
```

**Current branch mode:**
```bash
git diff main...HEAD
git log main..HEAD --oneline
git rev-parse HEAD
```

If the diff is empty, report "No changes to review" and stop.

**Record the exact commit reviewed.** Keep `headRefOid` (or the `git rev-parse` output) — it goes in the
report header in Step 5. Findings cite `file:line` as the file reads *at that commit*, so without the SHA
nobody can later tell a stale line number from a fixed finding.

### Step 3: Launch specialized reviewers in parallel

Launch the selected review agents **in parallel** as sub-agents.

For each agent, set:
- `subagent_type` to the reviewer name
- `model` per the depth table below (Claude Code only — Cursor CLI inherits the parent model)
- `prompt` with enough context for the sub-agent to work independently (see template below). The prompt's "Do NOT fix code — report findings only" line is the read-only guarantee — reviewers must not modify files.

**Model per reviewer and depth:**

| Reviewer | `--depth standard` (default) | `--depth max` |
|---|---|---|
| security-reviewer | `opus` | session model |
| correctness-reviewer | `opus` | session model |
| performance-reviewer | `sonnet` | session model |
| consistency-reviewer | `sonnet` | session model |

- Model ladder, weakest → strongest: `haiku` < `sonnet` < `opus` < `fable`.
- **The session model is a ceiling at every depth.** The model passed to a reviewer is the weaker of (table value, session model family). A Sonnet session therefore runs correctness on `sonnet` at standard depth, not `opus`; an Opus session runs a max pass entirely on `opus`, not `fable`.
- `--depth max` raises every reviewer to the ceiling: all four run on the session model family.
- Correctness gets `opus` by default at standard depth: the bugs that matter most here are cross-file C++ lifetime/concurrency issues (object teardown across threads, GPU-kernel edge cases) that need deeper reasoning than diff-local pattern matching.
- Security gets `opus` for the same reason. The vulnerabilities that matter in this repo are not diff-local patterns — they are multi-file trust-boundary questions: whether a `pull_request_target` workflow lets fork code reach a credential, whether an approval gate binds to a mutable ref, whether a composite action three files away persists a token into a workspace that untrusted code later reads. Answering those means reading the called action, the gate implementation and the environment configuration together, and confirming the claim against the live repo rather than pattern-matching the diff. A reviewer that stops at the diff produces plausible-sounding findings on the wrong lines.
- `review.maxDepthModel` in `packages/ocr-ggml/.agent/config.json` defaults to `"session"` (use the session model). Setting it to an explicit model name (`fable`, `opus`, …) **pins** max depth to that model and bypasses the ceiling — an escape hatch for deliberately escalating past the session model.
- If the local Claude Code version rejects the resolved model name, fall back to `opus`; if that is also rejected, omit `model` and let the agent definition decide.
- On Cursor CLI there is no per-agent model override — reviewers inherit the parent model, which matches the ceiling rule by construction. For a maximum-depth pass, run the parent session on the strongest available model.

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

Collect results from all reviewers and present a unified report.

**Every written report opens with this header block**, immediately under the H1, before any prose. It is a
required part of the output, not decoration — see the note below:

```markdown
# Code Review — <target>

**PR:** [<title>](https://github.com/<owner>/<repo>/pull/<n>)
**Reviewed at:** `<owner>/<repo>@<head-sha>` · **Base:** `<base-branch>` · **Head:** `<head-branch>`
**Reviewed:** <YYYY-MM-DD> · **Depth:** <standard|max> · **Reviewers:** security, correctness, performance, consistency
```

For branch or current-branch mode, drop the `**PR:**` line and use
`**Reviewed at:** \`<repo>@<sha>\` · **Base:** \`main\` · **Head:** \`<branch>\``.

For a report covering several PRs, repeat the block under each per-PR heading rather than once at the top —
each PR has its own head SHA, and a stack's shared summary table is not a substitute for it.

Then the findings themselves:

```
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

### Step 6: Write the feedback document

**Always write the report to a file — do not ask first.** The chat summary is ephemeral; the file is what
`/post-feedback` consumes to file line-anchored PR comments, and what a human re-reads days later.

**Path** — repo root of the working repo (alongside the existing `PR*-feedback.md` docs):

| Mode | Filename |
|---|---|
| PR review | `PR<number>-claude-feedback.md` |
| Branch / current branch | `<branch-slug>-claude-feedback.md` (slashes → `-`, e.g. `feature-QVAC-22734-claude-feedback.md`) |

The `claude` segment is the tool that produced the review. On Cursor it is `cursor` instead. This is not
cosmetic: both tools review the same PRs, and a shared `PR<n>-feedback.md` would have one silently
overwrite the other. A plain `PR<n>-feedback.md` is reserved for a human-merged consolidation of both.
Re-reviewing the same PR with the same tool **overwrites** the same path — `/post-feedback` keeps its own
run state keyed on the PR, so a fresh document is not a fresh conversation.

**Required shape.** `/post-feedback` parses this document, and it **refuses documents whose findings are
only table rows or only bullets**. Every finding must be a heading with a ref line:

```markdown
#### [SEVERITY · domain] one-line title
`path/to/file.ext:17-18`

*First whole sentence, in italics, on its own line.*

<prose body: evidence, why it is wrong, impact, then the fix>
```

- `SEVERITY` ∈ `CRITICAL` · `HIGH` · `MEDIUM` · `LOW` · `NIT`. `domain` ∈ the four reviewer names.
- The **ref line is the bare backticked path**, on the first non-blank line after the heading.
- The *italic sentence is the finding's identity* — `/post-feedback` opens the posted comment with it
  verbatim. Nothing may sit between the ref line and that sentence.
- Group findings under `## Security` / `## Correctness` / `## Performance` / `## Consistency`.
- Put non-postable material (verified-clean notes, resolved questions, corrected reviewer claims) under
  headings **without** a severity tag, so it is never offered as a comment.

Also carry over into the file, beyond the chat summary:

- The Step 5 header block verbatim, plus a **Finding identity** note explaining the italic-sentence rule.
- Findings **deduplicated across reviewers** — one entry per defect, noting cross-confirmation, not one
  entry per reviewer that found it.
- Any reviewer claim you **disproved**, under a `## Corrected reviewer claim` heading. Reviewers are
  wrong often enough that silently dropping a bad finding loses the correction.

**Verify every line number before writing it.** Reviewers report anchors that do not exist — a `sed -n`
or `grep -n` against the file at the reviewed SHA costs seconds and these anchors become PR comment
positions. If you corrected any, say so in a note near the top of the document so nobody "restores" them.

Then tell the user the path in your chat reply.

### Step 7: Offer to fix

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
- On Claude Code, set `model` per the depth table in Step 3 (opus for correctness and security, sonnet for the pattern-oriented reviewers), clamped to the session model family; `--depth max` runs all four on the session model
- On Cursor CLI, reviewers inherit the parent model (no model override available)
- The skill itself coordinates and synthesizes — it does not duplicate reviewer work
- Writing the feedback document (Step 6) is **unconditional** — it is the deliverable, not an optional extra.
  The chat report is a summary of it, not a substitute
- Does NOT push to remote — the user handles that
- **The Step 5 header block is consumed by `/post-feedback`**, which files these findings as line-anchored PR
  comments. `**Reviewed at:**` gives it the commit the `file:line` references were written against, so it can
  say "this document is 12 commits stale" up front instead of discovering it one rejected comment at a time;
  `**PR:**` gives it a machine-readable target instead of guessing from the filename. Do not drop either line
  as boilerplate — a report without them still reads fine to a human and silently degrades the tool that
  consumes it.
