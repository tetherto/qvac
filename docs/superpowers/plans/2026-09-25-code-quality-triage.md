# Code Quality Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic hotspot and triage artifacts plus a project skill that turns them into approval-gated, deduplicated Asana ticket proposals.

**Architecture:** The existing audit remains the finding source. Focused modules aggregate snapshot hotspots and build candidate groups with Git evidence; the project skill adds contextual judgment and owns approval-gated Asana reconciliation without modifying `qv-asana-sync`.

**Tech Stack:** TypeScript 5.9, Node test runner, Git CLI, Markdown/JSON, project Agent Skills, Node.js REST helper.

**Spec:** `docs/superpowers/specs/2026-09-25-code-quality-triage-design.md`

## Global Constraints

- Markdown audit output remains a current-state snapshot independent of baseline status.
- JSON and triage artifacts must be deterministic and contain no timestamps or absolute paths.
- No Asana mutation occurs without explicit approved proposal IDs.
- Do not modify `.agents/skills/qv-asana-sync`.
- Do not store Asana task IDs, private links, project IDs, or tokens in repository files.
- Default review page size is 10; all candidates remain in machine output.
- Git churn uses a 180-day window and records commit count plus last-change date as evidence, never as an opaque score.
- Do not commit changes unless the user separately requests it.

## Review Focus

- A cycle cluster with many overlapping paths must render once while retaining every original finding.
- A file with file-, function-, complexity-, nesting-, and fan-out findings must aggregate without losing symbol evidence.
- Git history with renames, shallow history, or no commits must produce stable partial evidence rather than fail triage.
- An analysis error or changed source report must block Asana application even if approval IDs were supplied.
- A repeated run against an existing group marker must propose no duplicate task.

---

### Task 1: Deterministic hotspot aggregation

**Files:**
- Create: `scripts/code-quality/hotspots.ts`
- Create: `scripts/code-quality/test/hotspots.test.ts`
- Modify: `scripts/code-quality/report.ts`
- Modify: `scripts/code-quality/test/report.test.ts`

**Interfaces:**
- Consumes: `readonly AuditedFinding[]`.
- Produces: `buildHotspots(findings): readonly Hotspot[]` and Markdown rendering input.

- [ ] **Step 1: Write failing file-hotspot and cycle-cluster tests**

Cover structural overlap on one file, fan-out attachment, disjoint files,
overlapping cycle paths, runtime/type-only counts, and deterministic ordering.

- [ ] **Step 2: Run the focused tests and confirm missing-module failures**

Run: `pnpm exec tsx --test scripts/code-quality/test/hotspots.test.ts scripts/code-quality/test/report.test.ts`

- [ ] **Step 3: Implement normalized hotspot types and overlap clustering**

Use connected components over cycle member overlap. Keep finding fingerprints in
each hotspot and derive stable IDs from kind plus canonical anchor.

- [ ] **Step 4: Add the compact Hotspots section to Markdown**

Render maximum severity, finding/rule counts, file symbols, and cycle cluster
hubs before `Findings by rule`. Do not render baseline lifecycle state.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm exec tsx --test scripts/code-quality/test/hotspots.test.ts scripts/code-quality/test/report.test.ts`
Run: `pnpm quality:typecheck`

### Task 2: Triage candidate model and Git evidence

**Files:**
- Create: `scripts/code-quality/triage-model.ts`
- Create: `scripts/code-quality/git-history.ts`
- Create: `scripts/code-quality/triage.ts`
- Create: `scripts/code-quality/test/git-history.test.ts`
- Create: `scripts/code-quality/test/triage.test.ts`

**Interfaces:**
- Consumes: `AuditedAnalysisResult`, repository root, optional `now` for tests.
- Produces: `buildTriageReport({ audit, root, now }): Promise<TriageReport>`.

- [ ] **Step 1: Write failing candidate and Git-history tests**

Test stable group IDs, lifecycle aggregation, threshold exceedance, source
profile, 180-day commit counts, last-change date, a renamed path, and an empty
repository history.

- [ ] **Step 2: Run tests and verify they fail before implementation**

Run: `pnpm exec tsx --test scripts/code-quality/test/git-history.test.ts scripts/code-quality/test/triage.test.ts`

- [ ] **Step 3: Implement focused triage types**

Define `TriageCandidate`, `TriageSignal`, `TriageReport`, ownership placeholders,
and lifecycle counts. Retain all covered finding fingerprints.

- [ ] **Step 4: Implement Git evidence through `git log`**

Invoke Git with argument arrays, normalize repository-relative paths, tolerate
no-history/shallow-history cases, and never include author identity or absolute
paths in output.

- [ ] **Step 5: Build candidates from hotspot groups**

File groups anchor on paths. Cycle groups anchor on canonical hub/member data.
Keep evidence fields separate rather than calculating a composite priority.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm exec tsx --test scripts/code-quality/test/git-history.test.ts scripts/code-quality/test/triage.test.ts`
Run: `pnpm quality:typecheck`

### Task 3: Triage command and human report

**Files:**
- Create: `scripts/code-quality/triage-cli.ts`
- Create: `scripts/code-quality/triage-report.ts`
- Create: `scripts/code-quality/test/triage-cli.test.ts`
- Create: `scripts/code-quality/test/triage-report.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `.quality/report.json` or a fresh `runAudit` result.
- Produces: `.quality/triage.json`, `.quality/triage.md`, and commands `quality:triage` and `quality:reporting`.

- [ ] **Step 1: Write failing deterministic rendering and command tests**

Assert top-10 default paging, all candidates in JSON, team/status filters,
analysis-error rejection, atomic writes, and byte-identical repeated output.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm exec tsx --test scripts/code-quality/test/triage-report.test.ts scripts/code-quality/test/triage-cli.test.ts`

- [ ] **Step 3: Implement stable JSON and Markdown rendering**

The Markdown first page shows candidate evidence and leaves contextual priority,
ownership overrides, and prose refinement for the skill.

- [ ] **Step 4: Implement CLI orchestration**

`quality:triage` consumes an existing successful audit. `quality:reporting` runs
audit then triage. Both fail on analysis diagnostics and write atomically.

- [ ] **Step 5: Document commands and generated artifacts**

Explain the distinction between audit evidence, deterministic candidates, and
agent-reviewed ticket proposals.

- [ ] **Step 6: Run focused tests, full tests, and typecheck**

Run: `pnpm quality:test`
Run: `pnpm quality:typecheck`

### Task 4: Project quality-reporting skill

**Files:**
- Create: `.agents/skills/qv-quality-reporting/SKILL.md`
- Create: `.agents/skills/qv-quality-reporting/agents/openai.yaml`
- Create: `.agents/skills/qv-quality-reporting/references/triage-config.json`
- Create: `.agents/skills/qv-quality-reporting/references/ticket-template.md`
- Create: `.agents/skills/qv-quality-reporting/references/scheduling.md`
- Modify: `.agents/skills/qv-skill-list/SKILL.md`

**Interfaces:**
- Consumes: `.quality/triage.json`, architecture scenario documents, and human feedback.
- Produces: top-10 contextual review and `.quality/proposals.json` suitable for approved application.

- [ ] **Step 1: Define ownership, importance, and group-override schema**

Encode SDK, NLP & Media Gen, and Speech path rules; route Vision to NLP & Media
Gen and Translation to Speech. Keep importance overrides empty or evidence-based,
with comments expressed through adjacent description fields rather than JSON
comments.

- [ ] **Step 2: Author the concise skill workflow**

Default invocation runs `quality:reporting`, reads the config and triage data,
reviews cohesion, assigns P1-P4 with rationale, generates ten proposals, and
stops for approval. It must not treat prior permission to run analysis as
permission to mutate Asana.

- [ ] **Step 3: Add proposal and schedule references**

Define the two-to-four sentence problem summary, evidence, ownership,
collaborators, remediation boundary, machine footer, and twice-monthly heartbeat
prompt with quiet-when-unchanged behavior.

- [ ] **Step 4: Add skill catalog entry and validate metadata**

Run the skill validator and ensure invocation guidance is discoverable without
loading all references.

### Task 5: Approval-gated Asana helper

**Files:**
- Create: `.agents/skills/qv-quality-reporting/scripts/asana-quality.mjs`
- Create: `.agents/skills/qv-quality-reporting/scripts/asana-quality.test.mjs`

**Interfaces:**
- Consumes: `proposals.json`, comma-separated approved proposal IDs, existing local developer-workflow Asana config/token.
- Produces: a dry-run reconciliation result or approved task creations/comments.

- [ ] **Step 1: Write failing helper tests against a local mock HTTP server**

Cover dry-run default, explicit approved creation, existing marker suppression,
approved regression comment, stale source hash, unknown approval ID, withheld
resolution state, and refusal to complete tasks.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test .agents/skills/qv-quality-reporting/scripts/asana-quality.test.mjs`

- [ ] **Step 3: Implement validation and reconciliation**

Default to `--dry-run`. Require `--approve <ids>` for writes. Search by stable
group marker before POST. Use config/token loading from the existing shared
developer-workflow library without changing `qv-asana-sync`.

- [ ] **Step 4: Implement creation and comment operations**

Create only approved new proposals in the configured project. Add comments only
for explicitly approved regressions. Never set assignee, due date, completion,
or private state in repository files.

- [ ] **Step 5: Run helper tests and full quality checks**

Run: `node --test .agents/skills/qv-quality-reporting/scripts/asana-quality.test.mjs`
Run: `pnpm quality:test`
Run: `pnpm quality:typecheck`

### Task 6: End-to-end and human-perspective verification

**Files:**
- Modify as required by observed usability failures only.

**Interfaces:**
- Consumes: the real repository and the new skill documentation.
- Produces: verified audit, triage, proposal, and dry-run reconciliation artifacts.

- [ ] **Step 1: Regenerate the baseline only if fingerprint behavior changed**

The triage feature should not normally change finding fingerprints.

- [ ] **Step 2: Run the documented default workflow twice**

Run: `pnpm quality:reporting`
Verify byte-identical audit and triage artifacts on the second run.

- [ ] **Step 3: Review the first page as a human**

Confirm the first ten groups explain what is wrong and where, avoid duplicate
cycle paths, show evidence without requiring JSON, and have usable team routing.

- [ ] **Step 4: Exercise proposal approval ergonomics**

Generate proposals, run the Asana helper in dry-run mode, select one proposal by
ID, and verify no file editing is required. Do not contact live Asana.

- [ ] **Step 5: Run final verification**

Run: `pnpm quality:test`
Run: `pnpm quality:typecheck`
Run: `git diff --check`
Run the audit/reporting workflow twice and compare hashes.
