# QVAC — Agent Context

## Overview

QVAC (Quantum Versatile AI Compute) is a monorepo for building local-first, P2P AI applications. Cross-platform support for Node.js, Bare runtime, and Expo.

## Build Commands

### Native Addons (C++ packages)
```bash
npm install
bare-make generate
bare-make build
bare-make install
```

### SDK (packages/qvac-sdk)
```bash
cd packages/qvac-sdk
bun install
bun run build       # lint + typecheck + compile
bun run lint        # eslint + typecheck
bun run format      # prettier check
```

### Environment Variables
Required tokens (see .env.example):
- `GH_TOKEN` — GitHub PAT for qvac-registry-vcpkg access
- `HF_TOKEN` — HuggingFace token for model license verification
- `NPM_TOKEN` — npm token for @qvac scoped packages

## Test Commands

### SDK
```bash
bun run test:unit
bun run test:security
bun run test:security:bare
```

### Native Addons
```bash
npm run test              # integration tests (brittle framework)
npm run test:cpp          # C++ unit tests (GoogleTest)
npm run test:integration  # full integration tests
npm run coverage:cpp      # code coverage (llvm-cov-19)
```

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
├── .claude/                   # Agent configuration
│   ├── settings.json          # Permission allowlist (Layer 0)
│   ├── agent-conduct.md       # Behavioral rules (Layer 2)
│   ├── prompts/               # Phase prompts for run-task.sh
│   │   ├── implementer.md
│   │   ├── reviewer.md
│   │   └── hardener.md
│   └── commands/addons/       # Custom commands for addon releases
├── .cursor/                   # Cursor IDE rules and skills
│   ├── rules/sdk/             # SDK coding conventions
│   └── skills/                # Automation skills
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
├── run-task.sh                # Agent orchestration script
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

See `.claude/agent-conduct.md` for behavioral rules that all agents must follow.

## Never Commit

- `.npmrc` files
- `.env` files
- `node_modules/`
- Build artifacts
