---
name: setup
description: Install the repository-wide Agent Skills compatibility view for Claude Code
argument-hint: "[claude]"
disable-model-invocation: true
---

Install the repository-wide skills for Claude Code.

Cursor and Codex discover `.agents/skills` directly and do not need this setup.

Execute the following command:

```bash
bash scripts/agent-setup.sh claude
```

After running, report which compatibility entries were linked or copied. This
setup does not install package-specific agent frameworks.
