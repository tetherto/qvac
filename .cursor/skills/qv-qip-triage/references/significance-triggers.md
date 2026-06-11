# Architectural significance triggers

Use this checklist conservatively. Prefer false negatives over false positives.

## Core triggers

A change is architecturally significant when it clearly does any of the following:

- Crosses a package boundary or introduces a new cross-package import
- Changes a public SDK API surface (anything an app or third-party integrator can import)
- Adds a native dependency or platform-specific code path
- Touches the addon, plugin, or model registry contract
- Introduces a new runtime, transport, or storage technology
- Changes a published NFR threshold (binary size, startup time, crash-free rate, platform coverage)
- Conflicts with a published principle or manifesto property

Published principles live in `docs/architecture/PRINCIPLES.md`.

## CI and delivery triggers

CI changes are significant only when they affect delivery architecture, such as:

- npm publishing or release flow
- Deployment topology or deployment schema
- Security enforcement, approval gates, or trust boundaries in CI
- Artifact signing, provenance, or attestation
- Prebuild distribution or platform support matrix in release pipelines

These are **not** significant by themselves:

- Routine lint or test workflow edits
- Dependency cache tuning
- Matrix cleanup or runner label changes
- Flaky-test fixes
- Localized workflow refactors that do not change release, publishing, deployment, security, or approval behavior

## Non-triggers

Do not recommend a QIP for ordinary work such as:

- Localized bug fixes
- Internal refactors with no contract change
- Routine test coverage
- Documentation edits
- Small PRs that stay inside one package and do not change stable contracts

## High-confidence bar

Recommend a QIP only when at least one trigger clearly affects:

- A stable contract others depend on
- A cross-team dependency
- Delivery or release architecture
- A security boundary
- A supported runtime or platform
- A published architectural principle

If the case is borderline, continue without interrupting the user.
