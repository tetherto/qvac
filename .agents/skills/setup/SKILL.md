---
name: setup
description: Run packages/ocr-ggml/.agent/setup.sh to install skills, knowledge, and config for Claude Code or Cursor
argument-hint: "[claude|cursor|all]"
disable-model-invocation: true
---

Run the agent config setup script to configure tooling for the specified agent.

Use the requested target, or `all` when none is provided. Valid targets are
`claude`, `cursor`, and `all`. Claude Code and Cursor substitute `$ARGUMENTS`
when the skill is invoked as a slash command; on another host, replace it with
the target from the user's request.

Execute the following command:

```bash
bash packages/ocr-ggml/.agent/setup.sh $ARGUMENTS
```

After running, report what was copied/generated.
