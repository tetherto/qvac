# Repository Agent Skills

Repository skills live under `.agents/skills/<skill-name>/`. Each skill follows the
[Agent Skills specification](https://agentskills.io/specification) and may carry
host-specific metadata without duplicating its instructions.

## Host compatibility

- Codex and Cursor discover `.agents/skills` directly. Do not mirror repository
  skills into `.cursor/skills`.
- Claude Code uses `.claude/skills`. Run `/setup claude` after cloning; setup
  runs `scripts/agent-setup.sh` to create ignored per-skill symlinks on Unix and
  copies on Windows. It installs only repository-wide skills; package-specific
  agent frameworks remain opt-in.
- If Cursor also shows the generated Claude entries, its third-party configuration
  compatibility is enabled. Disable **Include third-party Plugins, Skills, and
  other configs** in Cursor to show only `.agents/skills`; this also disables other
  third-party configuration compatibility.

## Layout

```text
.agents/skills/<skill-name>/
├── SKILL.md
├── agents/openai.yaml   # optional Codex metadata
├── references/          # optional detailed material
├── scripts/             # optional vendored helpers
└── assets/              # optional templates or data
```

## Authoring rules

- Use a lowercase, hyphenated directory name that matches the frontmatter `name`.
- Give `description` both the capability and the circumstances that should trigger
  it. Write it in the third person.
- Keep `SKILL.md` focused on the workflow and essential decisions. Put substantial
  reference material in `references/`, one level deep.
- Vendor scripts a repository skill executes. Do not fetch and execute remote code.
- Use `qv-<pod>-<action>` for pod-specific skills and `qv-<action>` for cross-pod
  workflows.
- Mark manual-only behavior in each host's supported metadata. Do not assume one
  host's invocation field controls the others.
- Require confirmation inside a skill before it posts, publishes, merges, or mutates
  an external system unless the user's request already authorizes that exact action.
- Refer to current repository sources instead of copying package rosters, versions,
  workflow matrices, or other volatile facts into a skill.

Keep the main instructions concise. Add examples only when they resolve a real
ambiguity, and test script-backed skills from a clean checkout. Run
`node scripts/ci/validate-agent-config.mjs` before handoff.

## Migrating existing Claude skill links

`/setup claude` automatically replaces per-skill links that point to the former
`.cursor/skills/<name>` location. It unlinks only the compatibility link and does
not modify its `.cursor` target.

If `.claude/skills` itself is a symlink, setup stops without changing it because
the shared target may contain personal skills. Inspect that target and preserve
anything still needed, then remove only the directory symlink and rerun setup:

```bash
rm .claude/skills
bash scripts/agent-setup.sh claude
```

Any other existing file, directory, or unrelated symlink at a generated skill
destination is also left untouched. Setup reports the collision so it can be
moved or removed explicitly.
