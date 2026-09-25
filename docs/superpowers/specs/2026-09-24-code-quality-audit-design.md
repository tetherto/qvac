# Deterministic Code Quality Audit

## Purpose

Provide agents and humans with a deterministic, reproducible assessment of
maintainability debt in the JavaScript and TypeScript portions of the monorepo.
The audit complements tests and review; it does not produce a composite quality
score or claim semantic correctness.

## Architecture

The root command orchestrates independent detector adapters. Each adapter owns
its third-party tool configuration and converts raw results into one normalized
finding model. The reporting and baseline layers know nothing about ESLint or
dependency-cruiser, allowing dead-code and duplication detectors to be added
without changing existing detectors.

The first version contains:

- an ESLint-backed structural detector for file length, function length,
  modified cyclomatic complexity, and nesting depth;
- a dependency-cruiser-backed detector for local module cycles, unresolved
  imports, and local fan-out;
- a package-manifest graph check for cycles between workspaces;
- deterministic Markdown and JSON reports plus a tracked fingerprint baseline.

Detector failures and incomplete dependency graphs are analysis errors. Quality
findings are advisory and do not make the command fail. This prevents a clean
report from being confused with a detector that silently failed.

## Scope and thresholds

Scan tracked and untracked, non-ignored JavaScript and TypeScript source files.
Exclude declarations, generated output, vendored sources, dependencies,
coverage, build output, and prebuilds. Vendored path segments include
`vendor` and `third-party`. Production code is source outside test, fixture,
example, benchmark, script, and configuration paths; everything else in scope
is auxiliary.

| Metric | Production advisory/high | Auxiliary advisory/high |
| --- | --- | --- |
| File code lines | 300 / 500 | 600 / 1000 |
| Function code lines | 50 / 100 | 100 / 200 |
| Modified complexity | 15 / 25 | 20 / 35 |
| Nesting depth | 4 / 6 | 5 / 7 |
| Local fan-out | 20 / 30 | 25 / 40 |

File and function size exclude blank and comment-only lines. Local fan-out
counts the distinct local modules imported by a module; it measures outgoing
dependency breadth, not how many modules depend on the source.

Runtime module cycles and package cycles are high severity. The dependency
detector builds a separate graph with TypeScript pre-compilation edges removed;
only cycles present in that runtime graph are classified as runtime cycles.
Cycles found only in the combined graph contain at least one type-only edge and
are advisory. Unresolved imports are analysis errors unless explicitly exempted
in configuration.

## Findings and fingerprints

Every finding has a detector, rule, category, severity, human explanation,
remediation guidance, primary location, zero or more related locations, and
optional measured value and thresholds. Reports include detector versions and
coverage counts.

Fingerprints identify the debt rather than its current measurement. They exclude
severity, thresholds, message wording, absolute paths, and line numbers. File
findings use detector + rule + repository path. Function findings use named
lexical scopes, static callback labels, and owning variables or properties,
with a scope-local ordinal only where no stronger semantic identity exists.
Cycles use a canonical rotation and direction. Fingerprints are versioned
SHA-256 values so the algorithm can evolve deliberately.

The baseline stores enough finding metadata to identify resolved findings after
the source finding disappears. The machine report labels current findings as
new or existing, reports measurement and severity drift for matching
fingerprints, and lists baseline entries absent from a complete current run as
resolved. If any detector produces an analysis error, resolution calculation is
withheld rather than treating a partial result as improvement.

## Report behavior

Markdown is a snapshot of the current codebase and does not change when only the
baseline changes. It summarizes current high and advisory findings by rule, then
groups every current finding into compact tables. Each row contains the severity,
short fingerprint, measured value and thresholds, repository-relative location,
and any semantic function or cycle identity. Rule guidance supplies the
explanation and specific next action.

JSON adds stable new, existing, and resolved classifications, measurement and
severity changes, and an explicit resolution status for agents tracking progress
against the baseline. No timestamps or machine-specific absolute paths appear in
either format, keeping identical inputs and baseline byte-for-byte reproducible.

Commands:

- `pnpm quality:audit` writes `.quality/report.md` and `.quality/report.json`.
- `pnpm quality:baseline` replaces the tracked baseline with current findings.
- `pnpm quality:test` runs the audit implementation tests.
- `pnpm quality:typecheck` validates the audit implementation.

The initial rollout is local and advisory; no CI workflow is added.
