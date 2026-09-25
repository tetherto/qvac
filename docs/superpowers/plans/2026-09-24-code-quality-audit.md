# Deterministic Code Quality Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, extensible code-quality audit with reliable findings, readable reports, and stable progress fingerprints.

**Architecture:** A TypeScript orchestrator discovers source files, invokes isolated detector adapters, normalizes findings, compares them with a tracked baseline, and renders deterministic JSON and Markdown. ESLint owns structural AST rules; dependency-cruiser owns module graph analysis; package manifests provide the workspace graph.

**Tech Stack:** Node.js 22, TypeScript 5.9, tsx, node:test, ESLint 10, typescript-eslint 8, dependency-cruiser 18, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-24-code-quality-audit-design.md`

## Global Constraints

- Keep existing package ESLint configurations unchanged.
- Pin root audit dependencies exactly and regenerate `pnpm-lock.yaml` with pnpm 11.17.0.
- Findings remain advisory; detector/configuration failures exit non-zero.
- Reports contain no timestamps, absolute paths, or order derived from filesystem enumeration.
- Fingerprints exclude measurements, severity, thresholds, messages, and line numbers.
- Do not add CI integration in this change.

## Review Focus

- A line-only edit must not change a finding fingerprint.
- Reordering a cycle's starting node must not change its fingerprint, while reversing a directed cycle must.
- An unresolved import must produce an analysis error rather than a clean report.
- An absent or malformed baseline must have explicit, deterministic behavior.
- Markdown must remain useful when hundreds of findings exist and must be independent of baseline state; JSON must distinguish new, existing, and resolved debt.

---

### Task 1: Normalized findings, fingerprints, baselines, and reports

**Files:**
- Create: `scripts/code-quality/model.ts`
- Create: `scripts/code-quality/fingerprint.ts`
- Create: `scripts/code-quality/baseline.ts`
- Create: `scripts/code-quality/report.ts`
- Test: `scripts/code-quality/test/fingerprint.test.ts`
- Test: `scripts/code-quality/test/baseline.test.ts`
- Test: `scripts/code-quality/test/report.test.ts`

**Interfaces:**
- Produces: `Finding`, `AnalysisResult`, `AuditedFinding`, `Baseline`, `fingerprintFinding(finding)`, `compareWithBaseline(findings, baseline)`, `renderJson(result)`, and `renderMarkdown(result)`.
- Consumes: no prior task interfaces.

- [ ] **Step 1: Write failing tests** for stable file/function fingerprints, canonical directed cycles, baseline new/existing/resolved classification, deterministic ordering, baseline-independent Markdown snapshots, and malformed baseline errors.
- [ ] **Step 2: Run `pnpm exec tsx --test scripts/code-quality/test/{fingerprint,baseline,report}.test.ts`** and confirm failure because the modules do not exist.
- [ ] **Step 3: Implement the normalized discriminated unions and pure fingerprint, baseline, and renderer functions.** Use repository-relative POSIX paths and `quality-v1:<sha256>` fingerprints.
- [ ] **Step 4: Re-run the Task 1 tests** and confirm all pass.
- [ ] **Step 5: Commit Task 1** with message `feat: add quality finding and report model`.

### Task 2: Source inventory and structural detector

**Files:**
- Create: `scripts/code-quality/config.ts`
- Create: `scripts/code-quality/files.ts`
- Create: `scripts/code-quality/detectors/structure.ts`
- Test: `scripts/code-quality/test/files.test.ts`
- Test: `scripts/code-quality/test/structure.test.ts`
- Create fixture sources under: `scripts/code-quality/test/fixtures/structure/`

**Interfaces:**
- Consumes: `Finding` and `AnalysisResult` from Task 1.
- Produces: `discoverSourceFiles(root)`, `classifySourceFile(path)`, `STRUCTURE_THRESHOLDS`, and `analyzeStructure(context)`.

- [ ] **Step 1: Write failing tests** proving ignored/generated/declaration files are excluded, production and auxiliary profiles differ, all four metrics report exact values, function identities survive line insertions, and results are sorted.
- [ ] **Step 2: Run `pnpm exec tsx --test scripts/code-quality/test/{files,structure}.test.ts`** and confirm failure because the modules do not exist.
- [ ] **Step 3: Implement discovery using `git ls-files -co --exclude-standard -z` and one isolated ESLint run.** Register pinned ESLint built-in rules under advisory/high aliases and a closure-based scope collector to associate messages with stable function identities.
- [ ] **Step 4: Re-run the Task 2 tests** and confirm all pass.
- [ ] **Step 5: Commit Task 2** with message `feat: add structural quality detector`.

### Task 3: Dependency and workspace graph detectors

**Files:**
- Create: `scripts/code-quality/detectors/dependencies.ts`
- Create: `scripts/code-quality/graph.ts`
- Test: `scripts/code-quality/test/dependencies.test.ts`
- Test: `scripts/code-quality/test/graph.test.ts`
- Create fixture package, tsconfig, cycle, type-cycle, fan-out, and unresolved imports under: `scripts/code-quality/test/fixtures/dependencies/`

**Interfaces:**
- Consumes: source classification and normalized findings from Tasks 1-2.
- Produces: `analyzeDependencies(context)`, `analyzeWorkspaceCycles(root)`, and `canonicalDirectedCycle(nodes)`.

- [ ] **Step 1: Write failing tests** for runtime and type-only cycles, local fan-out thresholds, unresolved-import analysis errors, canonical cycle identity, and package-manifest cycles.
- [ ] **Step 2: Run `pnpm exec tsx --test scripts/code-quality/test/{dependencies,graph}.test.ts`** and confirm failure because the modules do not exist.
- [ ] **Step 3: Implement dependency-cruiser workspace analysis** with `tsPreCompilationDeps: "specify"`, local-only fan-out, runtime/type cycle separation, explicit unresolved diagnostics, and deterministic package graph traversal.
- [ ] **Step 4: Re-run the Task 3 tests** and confirm all pass.
- [ ] **Step 5: Commit Task 3** with message `feat: add dependency quality detector`.

### Task 4: CLI, root integration, and initial baseline

**Files:**
- Create: `scripts/code-quality/audit.ts`
- Create: `scripts/code-quality/cli.ts`
- Create: `scripts/code-quality/tsconfig.json`
- Create: `scripts/code-quality/test/cli.test.ts`
- Create: `scripts/code-quality/baseline.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Consumes: every detector and report interface from Tasks 1-3.
- Produces: `runAudit(options)`, `quality:audit`, `quality:baseline`, `quality:test`, and `quality:typecheck`.

- [ ] **Step 1: Write failing end-to-end tests** for deterministic report files, detector failure exit behavior, baseline replacement, snapshot Markdown, and machine-readable new/existing/resolved presentation.
- [ ] **Step 2: Run `pnpm exec tsx --test scripts/code-quality/test/cli.test.ts`** and confirm failure because the CLI does not exist.
- [ ] **Step 3: Implement orchestration and CLI commands**, write reports atomically, expose detector versions/coverage, and add concise README usage.
- [ ] **Step 4: Add exact root dependencies and regenerate the lockfile** with pnpm 11.17.0; add `.quality/` to `.gitignore`.
- [ ] **Step 5: Run the full audit tests and typecheck**, then generate and inspect the initial tracked baseline.
- [ ] **Step 6: Run `pnpm quality:audit` twice and compare report checksums** to prove deterministic output.
- [ ] **Step 7: Commit Task 4** with message `feat: add deterministic code quality audit`.

### Task 5: Whole-branch verification and review

**Files:** Modify only files required by confirmed review findings.

**Interfaces:** Consumes the complete branch and produces a verified implementation and review ledger.

- [ ] **Step 1: Run `pnpm quality:test`, `pnpm quality:typecheck`, and `pnpm quality:audit`.**
- [ ] **Step 2: Run `pnpm install --frozen-lockfile --lockfile-only`** to verify manifest/lockfile consistency.
- [ ] **Step 3: Review the whole branch against the spec**, paying special attention to the Review Focus cases and detector coverage diagnostics.
- [ ] **Step 4: Address Important/Critical findings with a failing test first**, rerun the full checks, and record deferred minor findings.
- [ ] **Step 5: Commit verified review fixes**, if any.
