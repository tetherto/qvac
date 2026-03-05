# .agent/ — Shared Agent Configuration

Canonical source for agent config used by both **Claude Code** and **Cursor**. The `setup.sh` script generates agent-specific files from this directory.

## Directory Layout

```
.agent/
  conduct.md              # Behavioral rules for all agents
  mcp.json                # Shared MCP server definitions (Asana, GitHub)
  setup.sh                # Setup script — generates .claude/ and .cursor/ config
  knowledge/              # Domain knowledge docs (CI, vcpkg, etc.)
  skills/                 # Unified skills/commands (plain markdown)
    addons/               # Native addon release skills
    sdk/                  # SDK pod package skills
      references/         # Supporting docs referenced by skills
  scripts/                # Executable scripts used by skills
    notice-generate/      # NOTICE file generation tooling
```

## Usage

```bash
# Configure both agents
.agent/setup.sh all

# Configure one agent
.agent/setup.sh claude
.agent/setup.sh cursor
```

Safe to re-run anytime. Generated files are marked `AUTO-GENERATED` and gitignored.

## How It Works

| Source in `.agent/` | Claude Code | Cursor |
|---|---|---|
| `conduct.md` | `.claude/agent-conduct.md` | Referenced via CLAUDE.md |
| `knowledge/*.md` | `.claude/knowledge/` | Read from `.agent/` directly |
| `skills/addons/*.md` | `.claude/commands/addons/` | `.cursor/commands/addons/` |
| `skills/sdk/*.md` | `.claude/commands/sdk/` | `.cursor/skills/` (with YAML frontmatter) |
| `scripts/` | Referenced by path | Referenced by path |
| `mcp.json` | Manual (user-level config) | `.cursor/mcp.json` (generated) |

## Editing

Edit files here, then re-run `setup.sh`. Never edit generated files in `.claude/` or `.cursor/` directly — they'll be overwritten on next setup.
