---
name: setup
description: Run .agent/setup.sh to install skills, knowledge, and config for Claude Code or Cursor
argument-hint: "[claude|cursor|all]"
disable-model-invocation: true
---

Run the agent config setup script to configure tooling for the specified agent.

Usage: /setup <agent>
Where <agent> is: claude, cursor, or all

Execute the following command:

```bash
bash .agent/setup.sh $ARGUMENTS
```

After running, report what was copied/generated.
