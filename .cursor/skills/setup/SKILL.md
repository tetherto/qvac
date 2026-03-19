---
name: setup
description: Run packages/ocr-onnx/.agent/setup.sh to install skills, knowledge, and config for Claude Code or Cursor
argument-hint: "[claude|cursor|all] [--force|--keep|--clean]"
disable-model-invocation: true
---

Run the agent config setup script to configure tooling for the specified agent.

Usage: /setup <target> [strategy]
Where <target> is: claude, cursor, or all
Where [strategy] is optional: --force, --keep, or --clean

This script:
- Copies shared agent config from `.agent/` into tool-specific directories at the git root
- Creates `.agent-handoff/` directory for inter-tool phase delegation
- Generates tool-specific `/handoff` and `/orchestrate` skills with hardcoded tool identity
- `.agent/config.json` is the role configuration file (read directly at runtime, not copied)

## Execution

Run the setup script:

```bash
bash packages/ocr-onnx/.agent/setup.sh $ARGUMENTS
```

## Conflict handling

The script checks for existing files before writing. The output uses status markers:
- `[N]` — new file written
- `[=]` — file unchanged (skipped)
- `[M]` — file differs from source (conflict)
- `[U]` — file updated (overwritten)
- `[S]` — file skipped (kept existing)
- `[D]` — file deleted (--clean only)

**If the script exits with code 3**, conflicts were detected. Present the conflict list to the user and ask which strategy they want:
- **Update** (`--force`): overwrite all differing files with new versions
- **Retain** (`--keep`): keep all existing files, only write new ones
- **Replace** (`--clean`): delete all setup-managed files and regenerate from scratch

Then re-run the script with the chosen flag appended:

```bash
bash packages/ocr-onnx/.agent/setup.sh $ARGUMENTS --force
```

If the script exits with code 0, report what was written/generated.
