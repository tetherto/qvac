# QVAC — Agent Context

## Setup (New Developers)

After cloning, run `.agent/setup.sh` to configure your agent tooling:

```bash
.agent/setup.sh all      # Configure both Claude Code and Cursor
.agent/setup.sh claude   # Configure Claude Code only
.agent/setup.sh cursor   # Configure Cursor only
```

This copies shared config (conduct rules, knowledge docs, skills/commands, MCP definitions) from `.agent/` into `.claude/` and `.cursor/`. Re-run anytime after pulling changes to `.agent/`.

## CRITICAL: Never Skip Tests

NEVER delete, disable, skip, or weaken existing tests. Fix the code or the test. If you cannot fix it, report on Asana and STOP. No exceptions.

## CRITICAL: Bash Command Rules

These rules are mandatory. Violating them blocks the automated pipeline.

- **NEVER use heredocs** (`<< EOF`), `cat >`, or `echo >` to write files — use the Write tool instead
- **NEVER use `$()` command substitution** in bash — write to a temp file instead (e.g. `git commit -F /tmp/msg.txt`). For `$(nproc)`, query `nproc` first then hardcode the value (e.g. `make -j12`)
- **NEVER chain commands** with `&&`, `||`, or `;` — make separate Bash tool calls. Use flags like `git -C <path>` instead of `cd <path> && git ...`
- **NEVER use pipes** (`|`) or redirects (`2>&1`, `2>/dev/null`) — use dedicated tools or separate calls
- **ALWAYS use dedicated tools**: Write instead of `cat >`, Read instead of `cat`, Grep instead of `grep`, Glob instead of `find`, Edit instead of `sed`

## Overview

QVAC (Quantum Versatile AI Compute) is a monorepo for building local-first, P2P AI applications. Cross-platform support for Node.js, Bare runtime, and Expo.

## Build & Test — Quick Reference

### Native Addons (C++ packages, e.g. qvac-lib-infer-llamacpp-llm)

**Prerequisites:** clang-19, libc++-19-dev, libc++abi-19-dev, vcpkg, bare >=1.24, bare-make

```bash
cd packages/<addon-package>
npm install                # install JS + native dependencies
bare-make generate         # generate CMake build files (downloads vcpkg deps)
bare-make build            # compile C++ addon
bare-make install          # install .bare prebuild to prebuilds/
```

Full one-liner: `npm install && bare-make generate && bare-make build && bare-make install`

**Testing:**
```bash
npm run test               # run all integration tests (brittle framework)
npm run test:integration   # same as above (generates all.js then runs bare test/integration/all.js)
npm run test:cpp           # C++ unit tests (GoogleTest)
npm run coverage:cpp       # C++ code coverage (llvm-cov-19)
bare test/integration/<name>.test.js  # run a single integration test
```

**Linting:**
```bash
npx standard <file>        # JS lint (standardjs)
npm run lint               # lint all JS (excludes addon/)
```

### SDK (packages/qvac-sdk)
```bash
cd packages/qvac-sdk
bun install
bun run build       # lint + typecheck + compile
bun run lint        # eslint + typecheck
bun run format      # prettier check
```

**Testing:**
```bash
bun run test:unit
bun run test:security
bun run test:security:bare
```

### Environment Variables
Required tokens (see .env.example):
- `GH_TOKEN` — GitHub PAT for qvac-registry-vcpkg access
- `HF_TOKEN` — HuggingFace token for model license verification
- `NPM_TOKEN` — npm token for @qvac scoped packages

## CI Pipeline

- 85+ GitHub Actions workflows in `.github/workflows/`
- Path-scoped: only affected packages build/publish
- PR workflows: `on-pr-*.yml` — sanity checks, C++ linting, tests
- Expensive tests gated behind `verify` label on PRs
- Prebuild workflows: `prebuilds-*.yml` — multi-platform native bindings
- Publishing: `main` → dev builds (GitHub Packages), `release-*` → npm

## Repository Structure

```
qvac/
├── CLAUDE.md                  # This file
├── .agent/                    # Shared agent config (canonical source)
│   ├── conduct.md             # Behavioral rules
│   ├── knowledge/             # Domain knowledge docs
│   ├── skills/                # Unified skills (both agents)
│   ├── scripts/               # Executable scripts used by skills
│   ├── mcp.json               # Shared MCP server definitions
│   └── setup.sh               # Setup script (configures .claude/ or .cursor/)
├── .claude/                   # Claude Code config (partly auto-generated)
│   ├── settings.json          # [MANUAL] Permission allowlist
│   ├── prompts/               # [MANUAL] Phase prompts (implementer, reviewer, hardener)
│   ├── agent-conduct.md       # [GENERATED] from .agent/conduct.md
│   ├── knowledge/             # [GENERATED] from .agent/knowledge/
│   └── commands/              # [GENERATED] from .agent/skills/
├── .cursor/                   # Cursor config (partly auto-generated)
│   ├── rules/                 # [MANUAL] .mdc files with Cursor-specific rules
│   ├── skills/                # [GENERATED] from .agent/skills/
│   ├── commands/              # [GENERATED] from .agent/skills/
│   └── mcp.json               # [GENERATED] from .agent/mcp.json
├── packages/                  # All packages (23+)
│   ├── qvac-sdk/              # Main SDK entry point
│   ├── qvac-cli/              # CLI tool
│   ├── qvac-lib-rag/          # RAG library
│   ├── qvac-lib-infer-*/      # Inference addons (LLM, TTS, OCR, etc.)
│   ├── qvac-lib-dl-*/         # Data loaders (filesystem, hyperdrive)
│   ├── qvac-lib-logging/      # Logging
│   ├── qvac-lib-error-base/   # Error handling base
│   ├── qvac-lib-registry-server/ # Distributed model registry
│   ├── ocr-onnx/              # OCR addon
│   └── docs/                  # Documentation
├── scripts/                   # Build and validation scripts
├── .github/workflows/         # CI/CD (85+ workflow files)
└── gitflow.md                 # Git workflow documentation
```

## Code Conventions

### Commit Message Format
```
prefix[tags]?: subject
```
Prefixes: `feat`, `fix`, `doc`, `test`, `chore`, `infra`, `mod`
Tags: `[api]` (non-breaking), `[bc]` (breaking), `[mod]` (model changes), `[notask]` (PR), `[skiplog]`

Examples:
- `feat: add RAG support for LanceDB`
- `fix[api]: fix completion stream error handling`

### PR Title Format
```
TICKET prefix[tags]: subject
```
Example: `QVAC-123 feat[api]: add new endpoint`

### TypeScript/SDK Rules
- Use function declarations, not arrow functions (unless necessary)
- Always use `@` aliases for imports, never relative paths
- No `any` or `unknown` unless absolutely necessary
- No return type annotations on function definitions
- Composition over classes (exception: error classes extending `QvacErrorBase`)
- Co-locate Zod schemas with code; lowercase names, uppercase inferred types
- Strict error handling: always use structured error classes, preserve `cause`

### C++ Rules
- `clang-tidy` for linting
- CMake-based builds with vcpkg
- GoogleTest for unit tests

## Git Workflow

- Fork-first model — contributors work in forks
- `main` — development main, publishes dev builds
- `release-<package>-<x.y.z>` — release lines, publishes to npm
- `feature-*` / `tmp-*` — shared dev streams (GitHub Packages)
- `temp-pitch/{name}` — agent-first pitch branches (one PR per pitch to main)

## Agent Conduct

See `.agent/conduct.md` for behavioral rules that all agents must follow (canonical source).
Generated copies are placed in `.claude/agent-conduct.md` by `.agent/setup.sh`.

## Knowledge Base

Domain-specific reference docs (canonical source in `.agent/knowledge/`, generated copies in `.claude/knowledge/`).
When a question relates to one of these topics, read the corresponding knowledge file before answering.

| Topic | When to read | File |
|-------|-------------|------|
| CI / GitHub Actions | CI failures, workflow triggers, validation, publishing | `.claude/knowledge/ci-validation.md` |
| vcpkg / native builds | vcpkg deps, triplets, registries, CMake integration, build failures | `.claude/knowledge/vcpkg-management.md` |
| llama.cpp Android | Cross-compiling llama.cpp, ADB deployment, Vulkan GPU, Android inference | `.claude/knowledge/llama-cpp-android.md` |

These topics are also handled by specialized agents (ci-validator, model-registry-updater, llama-cpp-android-runner).

## Never Commit

- `.npmrc` files
- `.env` files
- `node_modules/`
- Build artifacts
