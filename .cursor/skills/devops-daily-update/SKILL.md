---
name: devops-daily-update
description: Compose a daily standup / EOD update for a DevOps engineer in tetherto/qvac. Aggregates yesterday's merged PRs and commits, today's open PRs and CI, reviews owed, and blockers, and emits a copy-paste Slack/Asana message. Use when the user asks for a "daily update", "standup", or invokes /devops-daily-update.
disable-model-invocation: true
---

# DevOps Daily Update

Composes a structured daily update message ready to paste into Slack or Asana, sourced from the user's GitHub activity in `tetherto/qvac`.

The skill is read-only with respect to GitHub state and the local working tree. It NEVER posts the message — the user copies it manually.

## When to use this skill

**Use when:**

- User asks for a "daily update", "standup", "EOD", or "what did I do yesterday?"
- User invokes `/devops-daily-update`
- User asks to draft a status post for the team channel

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User has access to `tetherto/qvac`
- Optional: Asana MCP available — surfaces today's assigned tasks (degrades gracefully if not)

## Inputs

- **Optional**: `--since <ISO date>` — defaults to yesterday 00:00 in the user's local timezone. Use to extend the lookback (e.g. covering a Monday update of Friday's work: `--since 3d`).
- **Optional**: `--format slack | asana | markdown` — defaults to `markdown`. Slack uses `*bold*` and `<URL|text>`; Asana uses standard Markdown; `markdown` (default) uses GitHub-flavored Markdown.
- **Optional**: `--no-asana` — skip the Asana section even if the MCP is available.

If the user did not specify, default to yesterday 00:00 / `markdown`.

## Safety rules

This skill is read-only. It does NOT:

- Modify the user's working tree, branch, or any file under `~/.cache/`
- Post to Slack, Asana, or GitHub
- Write secrets to any output (the assembler must skip any string that matches a secret-pattern allowlist; see step 5)

The skill MAY write its assembled output to `/tmp/devops-daily-update-<YYYY-MM-DD>.md` so the user can `pbcopy < <path>`.

## Efficiency rules

Total shell calls per run: **≤ 6** (one per data source + one for the timestamp + one to write the temp file). Cache `gh api user` and reuse across calls in the same session. If a data source errors (e.g. Asana MCP not configured), continue with a "Asana: not configured" placeholder rather than failing the whole skill.

## Workflow

### 1. Resolve the lookback window

```bash
SINCE="$(date -u -v-1d -j -f "%Y-%m-%d" "$(date -u +%Y-%m-%d)" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d 'yesterday 00:00' +%Y-%m-%dT%H:%M:%SZ)"
echo "$SINCE"
```

Parse `--since` if provided (`Nd` → N days, `Nw` → N weeks, ISO date → that date 00:00 UTC).

### 2. Resolve the current user

```bash
gh api user --jq '.login' > /tmp/devops-daily-update-user.txt
```

Reuse via `Read` for the rest of the run.

### 3. Pull yesterday's merged PRs (mine)

```bash
gh search prs \
  --repo tetherto/qvac \
  --author "@me" \
  --merged-at ">=$SINCE" \
  --json number,title,url,mergedAt,additions,deletions \
  --limit 30 \
  > /tmp/devops-daily-update-merged.json
```

### 4. Pull my open PRs and reviews owed

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --mode my > /tmp/devops-daily-update-my.txt 2> /tmp/devops-daily-update-my.stderr
gh search prs \
  --repo tetherto/qvac \
  --review-requested "@me" \
  --state open \
  --json number,title,url,author,updatedAt \
  --limit 30 \
  > /tmp/devops-daily-update-reviews-owed.json
```

If `pr-status.mjs` stderr contains `SLACK_VALIDATION_REQUIRED`, follow the validation gate documented in [`pr-mine`'s workflow](../pr-mine/SKILL.md) (step 2). Do not present the daily update until the gate clears.

### 5. Pull recent CI runs (mine)

`gh run list` does not have an author filter. Approximate the user's runs by scoping to PRs/branches authored by them:

```bash
gh run list \
  --repo tetherto/qvac \
  --created ">=$SINCE" \
  --limit 50 \
  --json conclusion,event,headBranch,name,url,workflowName,headSha,displayTitle \
  > /tmp/devops-daily-update-runs.json
```

Filter client-side: keep runs where `headBranch` is the head of one of the user's PRs from steps 3 or 4. Surface failed runs in **Blockers**, surface in-progress runs in **Today**.

### 6. (Optional) Pull today's Asana tasks

If the Asana MCP is available, call `user-asana-get_my_tasks` (or equivalent — read the descriptor first per the rules) and filter for tasks due today / in-progress. If the MCP is unavailable, write `Asana: not configured` into that section.

### 7. Run a secret-pattern scrub on every assembled string

Before writing `/tmp/devops-daily-update-<YYYY-MM-DD>.md`, run a regex check on every PR title, branch name, and run name:

```
(sk_live_|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_|github_pat_|xoxb-|-----BEGIN [A-Z ]+ KEY-----)
```

If any string matches, redact the matching span (`[REDACTED]`) and add a chat-only note: "Daily update redacted N suspicious tokens — review the source PRs/runs manually." Never include the raw matched string anywhere.

### 8. Assemble the output

Render to `/tmp/devops-daily-update-<YYYY-MM-DD>.md` using the template below. Empty sections are kept with `_(none)_` so the structure is consistent across days.

````markdown
# Daily update — <YYYY-MM-DD> (DevOps)

## Yesterday

**Shipped:**
- #<num> — <title> ([link](<url>)) (+<add>/-<del>)
- ...

**No-PR work** _(only include if the user explicitly mentioned offline work)_:
- ...

## Today

**In flight (my open PRs):**
- #<num> — <title> ([link](<url>)) — <ready-to-merge | needs-review | needs-re-review | conflicts>
- ...

**Reviews owed:**
- #<num> — <title> by <author> ([link](<url>))
- ...

**Asana:** _(omit section if Asana not configured)_
- <task title> — due <date>
- ...

## Blockers

- **CI failing on #<num>** — <workflow name> ([run](<url>))
- **Stale (>3d) review on #<num>** — pinged <reviewer> on <date>
- **Conflicts on #<num>** — needs rebase
- ...

---

_Sources: gh search prs, gh run list, pr-status.mjs --mode my, Asana MCP. Generated: <ISO timestamp>._
````

If `--format slack` was requested, post-process the markdown to:

- Replace `**X**` with `*X*`
- Replace `[text](URL)` with `<URL|text>`
- Drop horizontal rules (`---`)
- Keep emoji and bullet structure

If `--format asana` was requested, leave the markdown as-is (Asana renders standard Markdown in rich-text comments).

### 9. Print the result

Print the assembled message in a fenced code block in chat, then print the temp-file path so the user can pipe it to clipboard:

```bash
pbcopy < /tmp/devops-daily-update-<YYYY-MM-DD>.md   # macOS
xclip -selection clipboard < /tmp/devops-daily-update-<YYYY-MM-DD>.md   # Linux
```

## Quality gates

Before printing the output, verify:

- [ ] Every PR/run referenced has a clickable URL
- [ ] Each "Yesterday → Shipped" item is genuinely merged (`mergedAt >= SINCE`), not just closed
- [ ] Each "Reviews owed" item is open and the user is in `requestedReviewers` (not a stale assignment)
- [ ] Each "Blockers → CI failing" item is on a PR the user authored or a branch they own
- [ ] No raw secret-shaped strings made it through the scrub
- [ ] Each section has either entries or `_(none)_`
- [ ] The temp-file path matches the day's ISO date

## References

- DevOps main rule: [.cursor/rules/devops/main.mdc](.cursor/rules/devops/main.mdc)
- Agentic automation rule: [.cursor/rules/devops/agentic-automation.mdc](.cursor/rules/devops/agentic-automation.mdc) (read-only default; bounded shell calls; idempotency)
- Cross-pod my-PRs skill: [.cursor/skills/pr-mine/SKILL.md](.cursor/skills/pr-mine/SKILL.md)
- DevOps PR status skill: [.cursor/skills/devops-pr-status/SKILL.md](.cursor/skills/devops-pr-status/SKILL.md)
- Pod metadata: [.github/teams/devops.json](.github/teams/devops.json)
