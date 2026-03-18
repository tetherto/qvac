# .agent/ — Agent-First Development Framework

Canonical source for agent config used by both **Claude Code** and **Cursor**. Run `/setup` after cloning to install everything.

## Quick Start

```bash
git clone https://github.com/tetherto/qvac
cd qvac
/setup claude          # or: /setup cursor, /setup all
/orchestrate <task>    # run full pipeline for an Asana task
```

The `<task>` argument accepts an Asana task ID or full URL:
- `1213560067347874`
- `https://app.asana.com/0/1234567890/1213560067347874`

## Directory Layout

```
.agent/
├── README.md               # This file
├── conduct.md              # Behavioral rules for all agents
├── mcp.json                # Shared MCP server definitions (Asana)
├── settings.json           # Canonical settings (permission allowlist)
├── setup.sh                # Copies .agent/ config into .claude/ or .cursor/
├── agents/                 # Agent definitions
│   ├── implementer.md
│   ├── test-writer.md
│   ├── ci-validator.md
│   ├── code-reviewer.md
│   ├── model-registry-updater.md
│   └── android-runner.md
├── knowledge/              # Domain knowledge docs (loaded on-demand)
│   ├── ci-validation.md
│   ├── vcpkg-management.md
│   ├── llama-cpp-android.md
│   └── registry-models.md
└── skills/                 # New skills (directory-based, SKILL.md format)
    ├── orchestrate/
    ├── release/
    └── ci-validate/

.claude/skills/setup/       # Bootstrap skill (tracked in git)
.cursor/skills/setup/       # Bootstrap skill (tracked in git)
```

After running `/setup`, agents, knowledge, and skills are copied into `.claude/` (or `.cursor/`). Generated files are gitignored — edit sources in `.agent/` instead.

## Tool Compatibility

Not all features work in both tools:

| Feature | Claude Code | Cursor |
|---|---|---|
| Skills (`/release`, `/ci-validate`) | Yes | Yes |
| Knowledge files (CI, vcpkg, etc.) | Yes (`.claude/knowledge/`) | Yes (`.cursor/rules/*.mdc`) |
| Conduct rules | Yes | Yes (as `.mdc` rules) |
| MCP (Asana) | Manual setup (`~/.claude/settings.json`) | Auto-generated (`.cursor/mcp.json`) |
| Agent definitions (implementer, reviewer, etc.) | Yes (`.claude/agents/`) | No — Cursor has no sub-agent spawning |
| `/orchestrate` (multi-agent pipeline) | Yes | No — relies on agent spawning |

**Cursor users** can use skills directly (`/release`, `/ci-validate`), get knowledge/rules context, and use Asana MCP. But the multi-agent orchestration pipeline (`/orchestrate`) and individual agent launching are Claude Code-only features.

## How Setup Works

| Source in `.agent/` | Destination |
|---|---|
| `agents/*.md` | `.claude/agents/` |
| `knowledge/*.md` | `.claude/knowledge/` |
| `skills/*/SKILL.md` | `.claude/skills/` and `.cursor/skills/` |
| `conduct.md` | `.claude/agent-conduct.md` |
| `settings.json` | `.claude/settings.json` |
| `mcp.json` | `.cursor/mcp.json` (reformatted) |

Existing skills in `.cursor/skills/` (addon-changelog, sdk-changelog, etc.) are not managed by setup — they remain as-is.

## Full Pipeline (`/orchestrate`)

```
Phase 0:    Setup         Parse Asana URL → read task → create feature branch
Phase 1:    Implement     implementer agent → write code, verify build/tests
Phase 1.5:  Analyze       Auto-detect if tests and CI are needed
Phase 1.75: Test          test-writer agent → add tests (if needed)
Phase 2:    CI            ci-validator agent → cross-platform CI (if native addon)
Phase 3:    Review        code-reviewer agent → review diff, fix issues
Phase 4:    Re-validate   ci-validator agent → re-run CI if reviewer made fixes
Phase 5:    PR            Push branch, create PR, link to Asana
Phase 6:    Report        Summary, mark Asana task complete
```

The orchestrator stops and reports at any failure point. The Asana task is updated with status at every stop.

### When Tests Are Added

| Signal | Tests? |
|---|---|
| New public API / exported functions | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Asana acceptance criteria describe testable behavior | Yes |
| Refactoring with no behavior change | No |
| Docs / config / CI only | No |
| Implementer already added tests | No |

### When CI Runs

Native addon packages have full CI workflows. See the **CI Package Mapping** table in `.agent/knowledge/ci-validation.md` for the list of 8 packages with CI and their short names.

SDK/TS packages get automatic PR checks via `pr-checks-sdk-pod`. All other packages (simple libraries, docs, config) have no CI triggers.

## Agents

| Agent | Role | Model |
|---|---|---|
| `implementer` | Write code, verify build/tests, commit | Opus |
| `test-writer` | Write automated tests for new/changed code | Sonnet |
| `ci-validator` | Trigger CI, monitor, diagnose failures | Sonnet |
| `code-reviewer` | Review diff, find bugs, fix issues | Opus |
| `model-registry-updater` | Add/update models in the registry | Sonnet |
| `android-runner` | Deploy and benchmark models on Android | Sonnet |

Each agent runs in isolation with fresh context and access to project knowledge.

## Skills

| Skill | Purpose |
|---|---|
| `/setup <agent>` | Install skills, knowledge, agents for Claude Code or Cursor |
| `/orchestrate <task>` | Full pipeline: implement → test → CI → review → PR |
| `/release <package>` | Release a package to NPM |
| `/ci-validate <package>` | Trigger and monitor CI for a package |

Existing skills in `.cursor/` (addon-changelog, sdk-changelog, etc.) continue to work as before.

## Parallel Execution

For multiple independent tasks, run agents in parallel with non-overlapping file scopes:

```bash
# Wave 1: independent tasks
/orchestrate <task-1>   # Feature A — touches packages/feature-a/
/orchestrate <task-2>   # Feature B — touches packages/feature-b/

# Review diffs from Wave 1 before proceeding

# Wave 2: dependent tasks
/orchestrate <task-3>   # Depends on task-1 and task-2
```

Rules:
- Parallel tasks **must not** modify the same files
- Review diffs between waves — cheapest moment to catch wrong approaches
- Check Asana for agent comments flagging ambiguity

## Troubleshooting

| Problem | Fix |
|---|---|
| Agent stops for permission prompt | Add the operation to `.agent/settings.json`, re-run `/setup` |
| Build gate fails | Check output, fix manually or in new session, re-run |
| Agent modifies wrong files | Make file scopes more explicit in Asana task |
| Agent stops on ambiguity | Answer the question in Asana, re-run |
| CI fails after push | Check `gh run list`; fix if related, note if not |
