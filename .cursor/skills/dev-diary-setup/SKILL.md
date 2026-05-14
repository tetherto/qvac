---
name: dev-diary-setup
description: Set up the opt-in local dev diary for any developer. Use when the user asks to enable diary logging, initialize diary capture, run diary --init, or configure local daily work updates.
disable-model-invocation: true
---

# Dev Diary Setup

Sets up local diary capture. The diary is off by default and only turns on after initialization succeeds.

Use this skill only for setup/enable/disable. For reading, editing, or adding diary entries after setup, use `dev-diary`.

## Asana Token Setup

When using `--asana` or an Asana config file, first show these instructions to the user before checking whether `ASANA_ACCESS_TOKEN` exists:

1. Open [Asana developer console](https://app.asana.com/0/my-apps).
2. Create a **Personal Access Token**.
3. Description suggestion: `Cursor local qvac-pr-skills`.
4. Permission model: Asana Personal Access Tokens do not require choosing scopes in this setup. The token acts as the current Asana user and can access whatever that user can access. For this workflow, that user must be able to read the workspace/project/tasks; for sync actions, the user must also be allowed to comment, move, and complete tasks in that project.
5. No OAuth app and no Asana MCP server are needed.
6. Store it in your default shell startup file or export it in the current shell. Cursor agents may not inherit the app environment, so the helper falls back to asking your default shell for this variable.

```bash
export ASANA_ACCESS_TOKEN='<token>'
```

7. Verify manually:

```bash
curl https://app.asana.com/api/1.0/users/me \
  -H "Authorization: Bearer $ASANA_ACCESS_TOKEN"
```

Docs: [Asana personal access token](https://developers.asana.com/docs/personal-access-token)

## Commands

Basic local diary only:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --init --basic
```

Local diary plus Asana config import:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --init /path/to/asanaconfig.json
```

Status:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --status
```

Disable:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --off
```

## Workflow

For Asana-backed setup:

1. Present the **Asana Token Setup** section above.
2. Do **not** run a raw shell check like `test -n "$ASANA_ACCESS_TOKEN"` or `echo "$ASANA_ACCESS_TOKEN"`. That only checks the agent process environment and bypasses the helper's default-shell fallback.
3. Run the init command directly and let `diary-cli.mjs` resolve the token from `process.env` or the user's default shell startup files:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --init /path/to/asanaconfig.json
```

4. If the helper reports a missing token, stop after showing its output. Do not replace it with a shorter "export token" message.
5. If init succeeds, confirm diary status:

```bash
node .cursor/skills/_lib/developer-workflow/diary-cli.mjs --status
```

## Rules

- Do not enable diary capture unless init succeeds.
- Do not ask for Slack channel during init.
- Do not write tokens, Asana IDs, or diary entries into repo files.
- If Asana is requested, walk the user through creating `ASANA_ACCESS_TOKEN` and verify `/users/me`.
- If an Asana config path is provided, it must contain only shared workspace/project/section/custom-field metadata.
- Never preflight token presence with raw shell env checks; always use `diary-cli.mjs` / `asana.mjs` so default-shell fallback is applied.
