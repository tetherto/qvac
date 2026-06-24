---
name: qv-devops-daily-update
description: Compose a daily standup in the team's Slack format (🔨 Done today / 📅 Planned for tomorrow / 🚧 Blockers / risks), aggregating recent PRs, reviews, and CI from tetherto/qvac. Use when asked for a daily update, standup, EOD, or invoking /qv-devops-daily-update.
disable-model-invocation: true
---

# DevOps Daily Update

Composes a standup / EOD update in the team's standard Slack format and writes it to a temp file ready to paste. Sourced from the user's GitHub activity in `tetherto/qvac` plus optional Asana context.

The skill is read-only with respect to GitHub state and the local working tree. It NEVER posts the message — the user copies it manually. The canonical Slack form is documented in [Step 8](#8-assemble-the-output).

## When to use this skill

**Use when:**

- User asks for a "daily update", "standup", "EOD", or "what did I do yesterday?"
- User invokes `/qv-devops-daily-update`
- User asks to draft a status post for the team channel

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- User has access to `tetherto/qvac`
- Optional: Asana MCP available — surfaces today's assigned tasks (degrades gracefully if not)

## Inputs

- **Optional**: `--since <ISO date | Nd | Nw>` — defaults to yesterday 00:00 in the user's local timezone. The default 24-hour lookback works for both EOD posts (late evening) and morning standups; extend it for Monday-after-weekend (`--since 3d`) or post-holiday (`--since 1w`).
- **Optional**: `--format slack | markdown` — defaults to `slack`. The Slack form is what gets pasted; Markdown is the chat preview form (`**bold**`, `[text](URL)`) and is also accepted by Asana rich-text comments.
- **Optional**: `--no-asana` — skip the Asana lookup even if the MCP is available.

If the user did not specify, default to yesterday 00:00 / `slack`.

## Safety rules

This skill is read-only. It does NOT:

- Modify the user's working tree, branch, or any file under `~/.cache/`
- Post to Slack, Asana, or GitHub
- Write secrets to any output (the assembler runs a regex scrub before file write; see step 7)

The skill MAY write its assembled output to `/tmp/devops-daily-update-<YYYY-MM-DD>.txt` so the user can `pbcopy < <path>`. The extension is `.txt` (not `.md`) because the canonical form is Slack mrkdwn, not GitHub-flavored Markdown.

## Efficiency rules

Total shell calls per run: **≤ 6** (one per data source + one for the timestamp + one to write the temp file). Cache `gh api user` and reuse via Read for the rest of the session. If a data source errors (e.g., Asana MCP not configured), continue with that section's items missing from the aggregate rather than failing the whole skill — the canonical form does not have an "Asana" section, so missing Asana data only thins out the bullet pools, not the layout.

## Workflow

### 1. Resolve the lookback window

```bash
SINCE="$(date -u -v-1d -j -f "%Y-%m-%d" "$(date -u +%Y-%m-%d)" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d 'yesterday 00:00' +%Y-%m-%dT%H:%M:%SZ)"
echo "$SINCE"
```

Parse `--since` if provided (`Nd` → N days, `Nw` → N weeks, ISO date → that date 00:00 UTC).

### 2. Resolve the current user

```bash
gh api user --jq '.login' > /tmp/devops-daily-update-user.txt
```

Reuse via `Read` for the rest of the run.

### 3. Pull recently-merged PRs (mine)

```bash
gh search prs \
  --repo tetherto/qvac \
  --author "@me" \
  --merged-at ">=$SINCE" \
  --json number,title,url,closedAt \
  --limit 30 \
  > /tmp/devops-daily-update-merged.json
```

These feed `🔨 Done today`. `gh search prs --json` does not expose `mergedAt`, `additions`, or `deletions` — only `closedAt` is available, and the `--merged-at ">=$SINCE"` filter already guarantees the result set is merged-in-window. If size signal is needed for the bullet wording, fetch it per-PR via `gh pr view <num> --json additions,deletions` (one extra call per PR — only do this when the user asks for it).

### 4. Pull my open PRs and reviews owed

```bash
node .cursor/skills/_lib/pr-skills/pr-status.mjs --mode my \
  > /tmp/devops-daily-update-my.txt 2> /tmp/devops-daily-update-my.stderr
gh search prs \
  --repo tetherto/qvac \
  --review-requested "@me" \
  --state open \
  --json number,title,url,author,updatedAt \
  --limit 30 \
  > /tmp/devops-daily-update-reviews-owed.json
```

If `pr-status.mjs` stderr contains `SLACK_VALIDATION_REQUIRED`, follow the validation gate in [`pr-mine`'s workflow](../qv-pr-mine/SKILL.md) (step 2). Do not present the daily update until the gate clears.

Output routing:

- Open PRs I authored that received commits since `$SINCE` (i.e., I pushed work on them today) → `🔨 Done today` with the action `addressed comments on the PR` (when the recent commits follow a review event) or `pushed updates on <topic>` (otherwise).
- Open PRs I authored without recent commits → `📅 Planned for tomorrow` with the action `continue / wrap up <topic>`.
- Reviews owed (`--review-requested "@me"`) → `📅 Planned for tomorrow` as `review #<num> — <title> by <author>`. **Cap surfaced reviews at 5** (sorted by `updatedAt` desc — most recent first); if the queue is longer, append a single line `(+N more review requests in queue — run /qv-devops-pr-status for the full list)`. A standup with 30 review-bullets is unreadable.
- Open PRs I authored with `mergeable: CONFLICTING` → `🚧 Blockers / risks` as `conflicts on #<num> — needs rebase`.
- Open PRs I authored with stale review requests (no review activity in >3 days) → `🚧 Blockers / risks` as `stale review on #<num> — pinged <reviewer> on <date>`.

### 5. Pull recent CI runs (filter to mine)

`gh run list` does not have an author filter. Approximate the user's runs by scoping to recent PR head branches:

```bash
gh run list \
  --repo tetherto/qvac \
  --created ">=$SINCE" \
  --limit 50 \
  --json conclusion,event,headBranch,name,url,workflowName,headSha,displayTitle \
  > /tmp/devops-daily-update-runs.json
```

Filter client-side: keep runs where `headBranch` matches one of the user's PRs from steps 3 or 4. Failed runs feed `🚧 Blockers / risks` as `CI failing on #<num> — <workflowName>`. In-progress / queued runs are NOT surfaced (too noisy for a daily update).

### 6. (Optional) Pull today's Asana tasks

If the Asana MCP is available and `--no-asana` was not passed, call the appropriate tool (read the descriptor first per the agentic-automation rule) to fetch the user's tasks. Filter to:

- Status = in-progress or due today/tomorrow → feed `📅 Planned for tomorrow` as `<TICKET>: <task title>`
- Status = blocked → feed `🚧 Blockers / risks` as `<TICKET>: blocked — <reason from notes>`

Asana tickets in the QVAC project follow the `QVAC-\d+` format and slot directly into the bullet shape.

If Asana is unavailable or `--no-asana` is set, skip this step. The output will rely on GitHub-derived items only.

### 7. Run a secret-pattern scrub on every assembled string

Before writing `/tmp/devops-daily-update-<YYYY-MM-DD>.txt`, run a regex check on every PR title, branch name, run name, Asana task title, and any user-provided extras:

```
(sk_live_|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_|github_pat_|xoxb-|-----BEGIN [A-Z ]+ KEY-----)
```

If any string matches, redact the matching span (`[REDACTED]`) and add a chat-only note: "Daily update redacted N suspicious tokens — review the source PRs/runs manually." Never include the raw matched string anywhere in the output, the chat preview, or the temp file.

### 8. Assemble the output

Build the message in two forms:

- **Slack form** (the canonical, matches the team template), saved to `/tmp/devops-daily-update-<YYYY-MM-DD>.txt`.
- **Markdown form** (for chat preview only), printed in chat.

Each item from steps 3–6 must be normalized to a `TICKET: action` bullet. Ticket extraction rules:

1. Extract `QVAC-\d+` (or `[A-Z]+-\d+`) from the PR title; that's the ticket.
2. If the PR title has no ticket, extract from the head branch name (e.g., `feat/QVAC-12345-thing`).
3. If still no ticket, fall back to `#<pr-number>` as the leading label.
4. The action is the PR-title subject (the part after `prefix[tags]:`), past tense for `Done today`, action-verb-leading for `Planned for tomorrow`. Drop the `prefix[tags]:` from the rendered action.
5. Sub-bullets are added when (a) the user provided extra context for that item, or (b) more than one PR shares the same ticket — the parent line is the ticket, sub-bullets are each PR.

#### Slack form (canonical)

```
🔨 *Done today*
- <TICKET-or-#num>: <past-tense action>
- ...
    - <optional sub-bullet>

📅 *Planned for tomorrow*
- <TICKET-or-#num>: <forward-looking action>
- ...

🚧 *Blockers / risks*
- N/A
```

Empty section → single bullet `- N/A` (literal). Three sections always rendered, in this order, separated by a single blank line. Bare ticket bullets (`- QVAC-13860` with no `:` and no action) are allowed when the work is self-evident from the ticket title.

#### Markdown form (chat preview only)

```
**🔨 Done today**
- <TICKET-or-#num>: <past-tense action>
- ...

**📅 Planned for tomorrow**
- <TICKET-or-#num>: <forward-looking action>
- ...

**🚧 Blockers / risks**
- N/A
```

(Same content, GitHub-flavored Markdown rendering for the chat preview only.)

#### Format-conversion cheatsheet

If the user requested `--format markdown`, save the Markdown form to the temp file too. Conversion rules between the two forms:

| Markdown | Slack |
|---|---|
| `**X**` | `*X*` |
| `*X*` (italic) | `_X_` |
| `[text](URL)` | `<URL\|text>` |
| `# H1` / `## H2` | not used (use Slack-bold instead) |
| Plain `QVAC-\d+` | Plain `QVAC-\d+` (the workspace's Slack/Asana integration auto-links) |
| 4-space-indented `- sub` | 4-space-indented `- sub` (Slack respects 4-space indent for sub-bullets) |

Do NOT pre-link ticket numbers via `<URL|TICKET>` — the workspace's Asana app handles auto-linking. Pre-linking conflicts with that and renders awkwardly.

### 9. Print the result

1. Print the Markdown form in a fenced code block in chat for the user to scan.
2. Print the path to the Slack-form temp file with copy commands:

   ```bash
   pbcopy < /tmp/devops-daily-update-<YYYY-MM-DD>.txt   # macOS
   xclip -selection clipboard < /tmp/devops-daily-update-<YYYY-MM-DD>.txt   # Linux
   ```

3. Offer: "Edit any line before posting? Tell me which ticket and the new action wording, and I'll regenerate."

## Quality Checklist

Before printing the output, verify:

- [ ] Three sections rendered, in order: 🔨 Done today / 📅 Planned for tomorrow / 🚧 Blockers / risks
- [ ] Section headings use the exact emoji and the exact section names from the canonical template
- [ ] Empty sections render as a single `- N/A` bullet (never `_(none)_`, never empty, never removed)
- [ ] Every bullet leads with `TICKET:` (or `#<pr-num>:` only when no ticket could be extracted)
- [ ] No bullet prefixes, no severity tags, no PR-state tags (`[needs-review]`, `[ready]`, etc.) — that meta is folded into prose actions
- [ ] Each `Done today` item is genuinely activity since `$SINCE` (merged PR, pushed commits, etc. — not stale)
- [ ] Each `Planned for tomorrow → review` item is open and the user is in `requestedReviewers`
- [ ] Each `Blockers / risks → CI failing` item is on a PR the user authored or a branch they own
- [ ] No raw secret-shaped strings made it through the scrub
- [ ] Slack form has no Markdown headings, no `**bold**` (uses `*bold*`), no GitHub-style links
- [ ] Temp-file path matches the day's local-tz ISO date

## References

- DevOps main rule: [.cursor/rules/devops/main.mdc](.cursor/rules/devops/main.mdc)
- Agentic automation rule: [.cursor/rules/devops/agentic-automation.mdc](.cursor/rules/devops/agentic-automation.mdc) (read-only default; bounded shell calls; idempotency)
- Cross-pod my-PRs skill: [.cursor/skills/qv-pr-mine/SKILL.md](.cursor/skills/qv-pr-mine/SKILL.md)
- DevOps PR status skill: [.cursor/skills/qv-devops-pr-status/SKILL.md](.cursor/skills/qv-devops-pr-status/SKILL.md)
- Pod metadata: [.github/teams/devops.json](.github/teams/devops.json)
