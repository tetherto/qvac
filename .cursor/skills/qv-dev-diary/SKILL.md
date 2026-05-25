---
name: qv-dev-diary
description: Read, inspect, and add local dev diary entries after diary setup. Use when the user asks to view today's diary, edit diary notes, add work to the diary, or check what has been logged.
disable-model-invocation: true
---

# Dev Diary

Operate on the local diary after setup. This is not the setup skill; use `qv-dev-diary-setup` for initialization.

Diary files live under `~/.config/qvac-pr-skills/diary/` and are never committed.

## Commands

Status:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --status
```

Read today's diary:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --read
```

Read a specific date:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --read YYYY-MM-DD
```

Print the diary file path:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --path YYYY-MM-DD
```

Append an entry:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --append '{"title":"Reviewed PR #123","summary":"Approved after checking tests.","type":"pr-review","pr":"123","ticket":"TICKET-123","status":"done"}'
```

## Editing

To edit existing diary text:

1. Get the path with `--path`.
2. Read the file with `ReadFile`.
3. Edit only the requested entry.
4. Preserve the existing markdown structure.

Do not put diary contents in repo files. Do not commit diary files.
