---
name: qv-dev-diary-setup
description: Set up the opt-in local dev diary for any developer. Use when the user asks to enable diary logging, initialize diary capture, run diary --init, or configure local daily work updates.
disable-model-invocation: true
---

# Dev diary setup

Set up local diary capture. The diary is off by default and only turns on after initialization succeeds.

Use this skill only for setup/enable/disable. For reading, editing, or adding diary entries after setup, use `qv-dev-diary`.

## Commands

Basic local diary only:

```bash
node .agents/skills/_lib/developer-workflow/diary-cli.mjs --init --basic
```

Status:

```bash
node .agents/skills/_lib/developer-workflow/diary-cli.mjs --status
```

Disable:

```bash
node .agents/skills/_lib/developer-workflow/diary-cli.mjs --off
```

## Rules

- Do not enable diary capture unless init succeeds.
- Do not ask for Slack channel during init.
- Keep diary entries and private configuration outside the repository.
