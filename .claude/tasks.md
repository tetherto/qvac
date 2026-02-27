# Tasks: Agent-First Development Framework

## Task 1: Write CLAUDE.md [parallel] - DONE
- **Asana ID**: 1213466436085815
- **Description**: Write CLAUDE.md for the qvac repo with build/test/CI commands, file structure, conventions
- **Acceptance**: Agent can build and test with zero additional context
- **Files**: `CLAUDE.md`
- **Verify**: Start a fresh agent session, ask it to build and run tests

## Task 2: Write agent-conduct.md [parallel] - DONE
- **Asana ID**: 1213466442049231
- **Description**: Write .claude/agent-conduct.md with behavioral rules based on Appendix B
- **Acceptance**: File exists, referenced from CLAUDE.md, rules are clear for agent consumption
- **Files**: `.claude/agent-conduct.md`
- **Verify**: Read the file, confirm all sections from Appendix B are covered

## Task 3: Configure settings.json [parallel] - DONE
- **Asana ID**: 1213437187773370
- **Description**: Write .claude/settings.json with permission allowlist based on Appendix A
- **Acceptance**: No permission prompts for build/test/git/Asana/GitHub operations
- **Files**: `.claude/settings.json`
- **Verify**: Start agent, read Asana task and run git status — no prompts

## Task 4: Pitch branches + context [depends: 1, 2, 3] - DONE
- **Asana ID**: 1213437187802000
- **Description**: Create pitch branch with .claude/pitch-context.md and .claude/tasks.md
- **Acceptance**: Branch has context files with goals, architecture, and task breakdown
- **Files**: `.claude/pitch-context.md`, `.claude/tasks.md`

## Task 5: Phase prompts + run-task.sh [parallel] - DONE
- **Asana ID**: 1213466449354832
- **Description**: Write implementer.md, reviewer.md, hardener.md and run-task.sh
- **Acceptance**: ./run-task.sh <id> runs all 3 phases with build+test gates
- **Files**: `.claude/prompts/implementer.md`, `.claude/prompts/reviewer.md`, `.claude/prompts/hardener.md`, `run-task.sh`
- **Verify**: Run script on a real task, confirm all 3 phases execute

## Task 6: Workflow documentation [parallel] - DONE
- **Asana ID**: 1213466449910179
- **Description**: Write workflow doc covering run-task.sh, parallel execution, pitch context writing
- **Acceptance**: Doc covers full workflow, team can onboard from it
- **Files**: `docs/agent-first-workflow.md`

## Task 7: Pilot run [depends: 4, 5]
- **Asana ID**: 1213437187773322
- **Description**: Validate framework on real pitch with parallel agents
- **Acceptance**: Tasks complete end-to-end, Asana updated, no merge conflicts
- **Verify**: Check Asana for agent summaries, branch builds and tests pass
