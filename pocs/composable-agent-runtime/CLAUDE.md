@AGENTS.md

## Claude Code

- Claude Code loads every `CLAUDE.md` in the directory tree above this folder, so the
  monorepo root `CLAUDE.md` is in context whether or not it applies. It does not govern
  this workspace. In particular its Bash restrictions — no `&&`, no pipes, no heredocs,
  no `$()` — exist to protect the addon publishing pipeline; ignore them here and use a
  normal shell.
- Run the `boundary-reviewer` agent before finishing a change that adds an export, moves
  a file between packages, or adds a cross-package import.
- `.claude/settings.json` allowlists the test, typecheck, and read-only commands used
  here, so those should not prompt.
