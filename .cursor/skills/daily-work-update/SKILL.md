---
name: daily-work-update
description: Generate a concise end-of-day work update from local diary, GitHub activity, PR queue state, and optional Asana config. Use when the user asks for daily update, EOD update, standup, or what they did today.
disable-model-invocation: true
---

# Daily Work Update

Generate a copy-paste-ready EOD update. Do not post it anywhere unless the user explicitly asks and confirms.

## Usage

Today:

```bash
node .cursor/skills/_lib/developer-workflow/daily-work-update.mjs
```

Specific date:

```bash
node .cursor/skills/_lib/developer-workflow/daily-work-update.mjs --date YYYY-MM-DD
```

With user-provided tomorrow/blocker text:

```bash
node .cursor/skills/_lib/developer-workflow/daily-work-update.mjs \
  --tomorrow $'Finish QVAC-12345\nFollow up on PR review' \
  --blockers "None"
```

## Sources

- Local diary files under `~/.config/qvac-pr-skills/diary/`
- GitHub PRs authored or reviewed by the current `gh` user
- PR queue state through `.cursor/skills/_lib/pr-skills/pr-status.mjs --json` when queue context is needed
- Asana through `.cursor/skills/_lib/developer-workflow/asana.mjs` when configured

## Output

Always ask the user for:

1. Tomorrow's planned work.
2. Current blockers / risks.

Then render all three Slack sections every time:

```text
:hammer: Completed today (<Day Date>)

- Approved: <ticket link>, <PR link>; <ticket link>, <PR link>
- Commented / Requested changes: <ticket link>, <PR link>
- <ticket link>, <PR link> - <authored/opened/merged work>

:calendar: Planned for tomorrow

- <user-provided plan>

:construction: Blockers / risks

- <user-provided blockers, or None>
```

Rules:

- Run `daily-work-update.mjs` and use stdout as the source of truth.
- Return the generated message verbatim as rendered Markdown in chat.
- Do not manually rewrite, summarize, "clean up", split, expand, or reformat the generated output.
- In particular, do not expand the `Approved:` review summary into one bullet per PR. If the generator emits `Approved: ...; ...`, preserve that one summary bullet.
- Prefer diary entries as the source of truth for Cursor work.
- Deduplicate by ticket ID, PR number, issue number, and URL.
- Present the final message directly in chat, not as a fenced code block.
- Use normal Markdown bullets (`- `). Do not escape bullets.
- Use Markdown link syntax for links so the chat renders clickable links: `[label](url)`.
- PR labels should be short, e.g. `[#123](https://github.com/org/repo/pull/123)`.
- Asana ticket labels should include ticket and task name when known, e.g. `[QVAC-12345 Task title](https://app.asana.com/...)`.
- Extract ticket IDs from GitHub PR titles using the configured ticket pattern and resolve them to Asana tasks when possible.
- Collapse PR reviews into summary bullets:
  - `Approved: [#123](...) - [QVAC-12345: task](...), [#124](...) - [QVAC-12346: task](...)`
  - `Commented / Requested changes: [#125](...) - [QVAC-12347: task](...)`
- Do not render GitHub-style plain references like `owner/repo#123` when a URL is available.
- Do not use Slack API mrkdwn link syntax like `<url|label>` for copy-paste output.
- Do not include internal setup noise such as "Diary initialized" or "enabled diary capture" in work updates.
- If diary/chat activity has no ticket, PR, issue, or URL, ask the user what it should link to before finalizing. Update the entry or include the mapping so the daily update is accurate.
- Keep bullets short.
- Always include `:hammer:`, `:calendar:`, and `:construction:` sections, even if one section is `None` or `No recorded activity`.
- Do not finalize the message without asking the user for tomorrow's plan and blockers unless the user already provided them.
- Preserve user-provided bullet points for tomorrow/blockers. Do not collapse them into a semicolon-separated one-liner.
- When invoking the CLI from a POSIX shell, pass multiline plans with `$'line one\nline two'` or quote literal newlines.
- Print only. Slack posting is optional/deferred and requires explicit confirmation.
