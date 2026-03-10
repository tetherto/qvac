# Agent Workflow

How agent-first development works in this repo.

## Quick Start

```bash
git clone https://github.com/tetherto/qvac
cd qvac
/setup claude          # install skills, knowledge, agents
/orchestrate <task>    # run full pipeline for an Asana task
```

The `<task>` argument accepts either an Asana task ID or a full URL:
- `1213560067347874`
- `https://app.asana.com/0/1234567890/1213560067347874`

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

### When tests are added

| Signal | Tests? |
|---|---|
| New public API / exported functions | Yes |
| New feature with user-facing behavior | Yes |
| Bug fix (regression test) | Yes |
| Asana acceptance criteria describe testable behavior | Yes |
| Refactoring with no behavior change | No |
| Docs / config / CI only | No |
| Implementer already added tests | No |

### When CI runs

| Changed files | CI? | Package |
|---|---|---|
| `packages/qvac-lib-infer-llamacpp-llm/**` | Yes | LLM |
| `packages/qvac-lib-infer-llamacpp-embed/**` | Yes | Embed |
| `packages/ocr-onnx/**` | Yes | OCR |
| `packages/qvac-lib-infer-onnx-tts/**` | Yes | TTS |
| `packages/qvac-lib-infer-whispercpp/**` | Yes | Whispercpp |
| `packages/qvac-lib-infer-parakeet/**` | Yes | Parakeet |
| `packages/qvac-lib-infer-nmtcpp/**` | Yes | NMTCPP |
| `packages/qvac-lib-decoder-audio/**` | Yes | Decoder-audio |
| SDK / TS packages | No | — |
| Docs, workflows, config, markdown | No | — |

## Agents

| Agent | Role | Model |
|---|---|---|
| `implementer` | Write code, verify build/tests, commit | Sonnet |
| `test-writer` | Write automated tests for new/changed code | Sonnet |
| `ci-validator` | Trigger CI, monitor, diagnose failures | Sonnet |
| `code-reviewer` | Review diff, find bugs, fix issues | Sonnet |
| `model-registry-updater` | Add/update models in the registry | Sonnet |
| `llama-cpp-android-runner` | Deploy and benchmark models on Android | Sonnet |

Each agent runs in isolation with fresh context and access to project knowledge.

## Skills

| Skill | Purpose | Auto-invocable? |
|---|---|---|
| `/orchestrate <task>` | Full pipeline: implement → test → CI → review → PR | No |
| `/release <package>` | Release a package to NPM | No |
| `/setup <agent>` | Install skills, knowledge, agents | No |
| `/ci-validate <package>` | Trigger and monitor CI for a package | No |
| `/addon-changelog` | Generate changelog for addon packages | Yes |
| `/addon-pr-description` | Generate PR description for addon packages | Yes |
| `/addon-release-notes` | Generate release notes for addon packages | Yes |
| `/sdk-changelog` | Generate changelog for SDK packages | Yes |
| `/sdk-pr-create` | Generate PR description for SDK packages | Yes |
| `/sdk-notice-generate` | Generate NOTICE files with license attributions | Yes |

## Knowledge Base

Domain-specific reference docs loaded on-demand:

| Topic | File |
|---|---|
| CI / GitHub Actions | `.claude/knowledge/ci-validation.md` |
| vcpkg / native builds | `.claude/knowledge/vcpkg-management.md` |
| llama.cpp Android | `.claude/knowledge/llama-cpp-android.md` |

Knowledge files are auto-read when the topic is relevant (configured in CLAUDE.md).

## Directory Structure

```
.agent/                          # Canonical source (committed to git)
├── AGENT_WORKFLOW.md            # This file
├── conduct.md                   # Behavioral rules for all agents
├── knowledge/                   # Domain knowledge docs
│   ├── ci-validation.md
│   ├── vcpkg-management.md
│   └── llama-cpp-android.md
├── skills/                      # Skills (directory-based, SKILL.md format)
│   ├── orchestrate/SKILL.md
│   ├── release/SKILL.md
│   ├── setup/SKILL.md
│   ├── ci-validate/SKILL.md
│   ├── addon-changelog/SKILL.md
│   ├── addon-pr-description/SKILL.md
│   ├── addon-release-notes/SKILL.md
│   ├── sdk-changelog/SKILL.md
│   ├── sdk-pr-create/SKILL.md
│   └── sdk-notice-generate/SKILL.md
├── scripts/                     # Scripts used by skills
├── mcp.json                     # Shared MCP server definitions
└── setup.sh                     # Installs config into .claude/ and .cursor/

.claude/                         # Claude Code config (partly auto-generated)
├── agents/                      # Agent definitions
│   ├── implementer.md
│   ├── test-writer.md
│   ├── ci-validator.md
│   ├── code-reviewer.md
│   ├── model-registry-updater.md
│   └── llama-cpp-android-runner.md
├── skills/                      # [GENERATED] from .agent/skills/
├── knowledge/                   # [GENERATED] from .agent/knowledge/
├── agent-conduct.md             # [GENERATED] from .agent/conduct.md
└── settings.json                # [MANUAL] Permission allowlist
```

## Error Handling

The orchestrator stops and reports at any failure point:
- Implementer fails → report error, stop
- CI fails after 2 loops → report persistent failure, stop
- Reviewer finds architectural concerns → report, stop
- PR creation fails → branch is still pushed, report error

At every stop point, the Asana task is updated with current status.
