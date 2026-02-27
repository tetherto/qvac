# Pitch: Agent-First Development Framework

## Goal

Establish a structured framework that puts coding agents in the driver's seat. Engineers steer, agents build. The framework provides standardized context loading, shared behavioral rules, deterministic quality gates, and parallel execution support.

## Architecture Decisions

- **4-layer configuration**: settings.json (permissions) → CLAUDE.md (conventions) → agent-conduct.md (rules) → pitch-context.md + tasks.md (per-pitch)
- **3-phase pipeline**: Implement → Review → Finalize, with deterministic build+test gates between phases
- **Fresh context per phase**: Each phase gets a new agent session — reviewer has no knowledge of implementer's reasoning
- **Script-driven orchestration**: `run-task.sh` controls the flow, not the agent — agents cannot skip steps
- **Wave-based parallelism**: Independent tasks run simultaneously, engineer reviews between waves

## Reference Files

- `.cursor/rules/sdk/main.mdc` — SDK coding conventions to reference for code style
- `.cursor/rules/sdk/commit-and-pr-format.mdc` — commit and PR format requirements
- `gitflow.md` — existing git workflow documentation

## Out of Scope

- Fully unattended agent runs — engineers still start sessions and approve PRs
- Custom agent tooling — using off-the-shelf tools with MCP servers
- Changes to Shape Up cycle, Asana structure, or estimation format
- Adapting to other agent tools (Cursor, etc.) — future iteration
