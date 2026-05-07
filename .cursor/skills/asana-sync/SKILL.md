---
name: asana-sync
description: Look up and update Asana tasks using local developer-workflow config and direct Asana REST calls. Use when the user asks to sync an Asana task, move task status, add a PR link to Asana, or validate Asana configuration.
disable-model-invocation: true
---

# Asana Sync

Manual Asana task lookup and lifecycle sync using direct REST helpers. No Asana MCP binary.

## Default Behavior

If the user invokes this skill without a ticket, task GID, or specific action, do not only run config validation and exit. Show the operation menu below and ask what they want to do.

Ask for the missing input:

- Ticket ID or task GID
- Desired action: `find`, `status`, `move`, `comment`, or `complete`
- Target status for `move`
- Comment text for `comment`

## Prerequisites

- Local config at `~/.config/qvac-pr-skills/config.json`
- `ASANA_ACCESS_TOKEN` set in the current environment or available from the user's default shell startup files, unless config uses a different `asana.tokenEnv`

Create the token:

1. Open [Asana developer console](https://app.asana.com/0/my-apps).
2. Create a **Personal Access Token** with a clear description, e.g. `Cursor local qvac-pr-skills`.
3. Permission model: Asana Personal Access Tokens do not require choosing scopes in this setup. The token acts as the current Asana user and can access whatever that user can access.
4. For status enrichment, the user must be able to read the configured workspace/project/tasks. For sync actions, the user must also be allowed to comment, move, and complete tasks in that project.
5. No OAuth app or Asana MCP server is needed.
6. Store it in your default shell startup file or export it locally. Cursor agents may not inherit the app environment, so the helper falls back to asking your default shell for this variable.

```bash
export ASANA_ACCESS_TOKEN='<token>'
```

7. Verify:

```bash
curl https://app.asana.com/api/1.0/users/me \
  -H "Authorization: Bearer $ASANA_ACCESS_TOKEN"
```

Docs: [Asana personal access token](https://developers.asana.com/docs/personal-access-token)

Validate:

```bash
node .cursor/skills/_lib/developer-workflow/config-init.mjs --validate --asana
```

## Common Operations

Show these options when no action is provided:

- `status` - validate local Asana config and token access
- `find <ticket>` - find an Asana task by ticket
- `task <task-gid>` - read a task by Asana GID
- `move <ticket-or-task-gid> <status>` - move task to configured status
- `comment <ticket-or-task-gid> <text>` - add task comment
- `complete <ticket-or-task-gid>` - mark task complete and move to completed

Available statuses: `todo`, `inProgress`, `blocked`, `inReview`, `readyForQa`, `qaPassed`, `staging`, `storeReview`, `readyForProd`, `completed`, `closed`.

Status / config validation:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs status
```

Find a task by ticket:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs find QVAC-12345
```

Read a task by Asana task GID:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs task <task-gid>
```

Move a ticket/task to a configured status. If `asana.statusOptions` is configured, this uses Asana's `custom_type_status_option`. Otherwise it falls back to old section movement:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs move QVAC-12345 inProgress
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs move QVAC-12345 inReview
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs move QVAC-12345 blocked
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs move QVAC-12345 completed
```

Add a comment, for example a PR URL:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs comment QVAC-12345 "PR opened: https://github.com/owner/repo/pull/123"
```

Complete a task and move it to configured `completed` status:

```bash
node .cursor/skills/_lib/developer-workflow/asana-cli.mjs complete QVAC-12345
```

## Lifecycle Mapping

Use this mapping after user confirmation:

- Start working: `move <ticket> inProgress`
- PR opened: `move <ticket> inReview`, then `comment <ticket> "PR opened: <url>"`
- Blocked: `move <ticket> blocked`, then comment with blocker context
- PR merged/done: `complete <ticket>`

For mutations, show the exact planned command first and wait for explicit user confirmation.

## Safety

- Never write tokens or Asana IDs into repo files.
- Do not mutate Asana without user confirmation unless the user already approved the lifecycle action in the current workflow.
- Use `/users/me` to discover the current user; never copy another developer's user GID.
