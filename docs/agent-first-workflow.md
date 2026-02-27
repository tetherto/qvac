# Agent-First Development Workflow

This document describes the agent-first development framework for the QVAC project. Engineers steer, agents build.

## Quick Start

```bash
# Run a single task
./run-task.sh <asana-task-id>

# Run parallel tasks (non-overlapping file scopes)
./run-task.sh 123 &
./run-task.sh 456 &
./run-task.sh 789 &
wait
```

## How It Works

### The Pipeline

Each task runs through 3 agent phases with deterministic gates:

```
./run-task.sh <asana-task-id>
│
├─ Phase 1: IMPLEMENT (agent session 1)
│    Agent reads Asana task → writes code → commits
│         ↓
│    ── GATE: build + test ──
│         ↓ pass                    ↓ fail → EXIT
│
├─ Phase 2: REVIEW (agent session 2, fresh context)
│    Agent reviews all changes → fixes issues → commits
│         ↓
│    ── GATE: build + test ──
│         ↓ pass                    ↓ fail → EXIT
│
└─ Phase 3: FINALIZE (agent session 3)
     Agent verifies → pushes → updates Asana
```

Key properties:
- **Fresh context per stage** — the reviewer doesn't know what the implementer was "thinking"
- **Deterministic gates** — the script verifies build/tests, not the agent self-reporting
- **Agents can't skip steps** — the script controls flow

### Configuration Layers

| Layer | File | Purpose | Lifetime |
|-------|------|---------|----------|
| 0 | `.claude/settings.json` | Permission allowlist | Permanent |
| 1 | `CLAUDE.md` | Project conventions, build commands | Permanent |
| 2 | `.claude/agent-conduct.md` | Behavioral rules | Permanent |
| 3 | `.claude/pitch-context.md` + `.claude/tasks.md` | Per-pitch context | Pitch branch only |

## Writing Pitch Context Files

When starting a new pitch, create these files on your pitch branch:

### pitch-context.md

Describe the pitch goals, architecture decisions, and references.

```markdown
# Pitch: [Name]

## Goal
[What this pitch delivers]

## Architecture Decisions
- [Key decision 1 and why]
- [Key decision 2 and why]

## Reference Files
- `path/to/existing/pattern.js` — follow this pattern for [X]
- `path/to/similar/feature.js` — similar feature to reference

## Out of Scope
- [What NOT to touch]
```

### tasks.md

Break the pitch into agent-sized tasks with non-overlapping file scopes.

```markdown
# Tasks

## Task 1: [Name] [parallel]
- **Asana ID**: 123456
- **Description**: [What to build]
- **Acceptance**: [Machine-verifiable criteria]
- **Reference**: `path/to/pattern/file`
- **Files**: `src/feature/new-file.js`, `test/feature/new-file.test.js`
- **Verify**: `npm test -- --filter "test_name"`

## Task 2: [Name] [parallel]
- **Asana ID**: 789012
- **Description**: [What to build]
- **Acceptance**: [Criteria]
- **Reference**: `path/to/pattern`
- **Files**: `src/other/file.js` (non-overlapping with Task 1)
- **Verify**: `npm test -- --filter "other_test"`

## Task 3: [Name] [depends: 1, 2]
- **Asana ID**: 345678
- **Description**: [What to build, depends on 1 and 2]
- **Acceptance**: [Criteria]
- **Files**: `src/integration/file.js`
- **Verify**: `npm test`
```

Rules for task breakdowns:
- One task = one agent session (2-4 hours max)
- Parallel tasks MUST have non-overlapping file scopes
- Every task has a Verify command
- Acceptance criteria must be machine-verifiable
- Always include a reference file for the agent to follow

## Parallel Execution

### Wave-Based Execution

Group independent tasks into waves. Run tasks within a wave in parallel.

```bash
# Wave 1: independent tasks (non-overlapping files)
./run-task.sh 123 &   # Task 1: Feature A
./run-task.sh 456 &   # Task 2: Feature B
./run-task.sh 789 &   # Task 3: Feature C
wait

# Engineer reviews diffs from Wave 1 before proceeding

# Wave 2: dependent tasks
./run-task.sh 321 &   # Task 4: depends on 1
./run-task.sh 654 &   # Task 5: depends on 1, 2
wait
```

### Between Waves

After each wave completes:
1. Review the diffs — this is the cheapest moment to catch wrong approaches
2. Check Asana for any agent comments flagging ambiguity
3. Resolve any issues before launching the next wave

### File Scope Rules

Parallel tasks MUST NOT modify the same files. If two tasks need to modify the same file, they cannot run in parallel.

Good:
```
Task 1 files: src/feature-a/*, test/feature-a/*
Task 2 files: src/feature-b/*, test/feature-b/*
```

Bad:
```
Task 1 files: src/shared/utils.js, src/feature-a/*
Task 2 files: src/shared/utils.js, src/feature-b/*  # CONFLICT: both touch utils.js
```

## Asana Conventions

### Agent Updates

Agents update Asana automatically at each stage:

| Event | Asana Action |
|-------|-------------|
| Task started | Comment: "Starting implementation" + understanding of task |
| Task completed | Comment: summary of changes, files modified, test results |
| Task failed (3 retries) | Comment: error details, what was tried, suggested fix |
| Ambiguity found | Comment: questions + assumptions, then STOP |
| All phases done | Mark task complete |

### What to Check

- Open your Asana board to see real-time agent progress
- Look for comments flagging ambiguity — agents will stop and wait for your input
- After completion, review the agent's summary comment for decisions made

## Reviewing Agent Output

### Between Waves (Quick Review)

```bash
# See what changed
git log --oneline main..HEAD
git diff main..HEAD --stat

# Spot-check key files
git diff main..HEAD -- path/to/critical/file.js
```

### Final PR Review

The engineer does a final review of the full pitch PR before merge:
1. `git diff main...HEAD` — review all changes
2. Check Asana for agent decision logs
3. Run full test suite one more time
4. Create PR to main

## Troubleshooting

### Agent stops for permission prompt
Check `.claude/settings.json` — the operation may not be in the allowlist. Add it and restart.

### Build gate fails
The pipeline exits on gate failure. Check the output, fix the issue manually or in a new agent session, then re-run the task.

### Agent modifies wrong files
Check `.claude/tasks.md` — file scopes may not be defined clearly enough. Make scopes more explicit.

### Merge conflicts between parallel tasks
File scopes were overlapping. Fix the conflict manually, then ensure tasks.md has truly non-overlapping scopes for future waves.

### Agent stops on ambiguity
Check the Asana task for the agent's comment. Answer the question in Asana, then re-run the task.

### CI fails after push
Check `gh run list` for details. If the failure is unrelated to the task, note it and proceed. If related, fix and re-push.

## Ownership Model

- **One engineer owns one pitch**
- Work on `temp-pitch/{name}` branch
- Run one or more agents in parallel on independent tasks
- Review between waves
- One PR per pitch to main at end of cycle
- Lead does final review on the PR before merge
