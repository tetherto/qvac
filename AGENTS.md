# Repository Agent Guide

Keep this file short. It defines stable agent behavior and points to authoritative
repository sources; it is not a duplicate developer handbook.

## Sources of truth

- Start with [`README.md`](README.md) for the product overview and entry points.
- Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  [`docs/gitflow.md`](docs/gitflow.md) for contribution, branch, PR, and release
  flow.
- Use the affected package's README, CONTRIBUTING file, manifest, and scripts for
  package-specific commands and conventions.
- Use [`docs/architecture/`](docs/architecture/) for published architecture and
  the active workflows and configuration for current CI behavior.
- Follow the nearest scoped `AGENTS.md` when one exists.

Do not copy commands, versions, package rosters, workflow counts, infrastructure,
or other volatile facts into agent instructions. Link to their owning source.

## Working agreement

- User instructions take precedence, followed by the nearest scoped instructions
  and current repository sources. Verify current behavior instead of preserving a
  historical workaround.
- Preserve unrelated changes in a dirty worktree.
- Diagnose reported failures from runtime evidence before editing. Add tests for
  the confirmed failure mode rather than speculative paths.
- Run the narrowest relevant package-owned lint, type, unit, and integration checks
  before handoff. Report any check that cannot run.
- Do not commit, push, post reviews or comments, publish, or otherwise mutate remote
  systems unless the user explicitly requests it.

## Maintaining the repository

- Rewrite documentation in place: replace obsolete or corrected prose instead of
  appending conversation history, correction notes, or parallel guidance. Changelogs,
  explicit migration records, and ADR/QIP supersession history are exceptions.
- Prefer improving an existing document over creating another source of truth.
- Never commit secrets or concrete private infrastructure details, internal IDs,
  or private document links. Use safe placeholders in public examples.
- Keep changes scoped, preserve established package boundaries, and use each
  package's own dependency and test tooling.
