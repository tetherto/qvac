---
name: boundary-review
description: Review a change in the composable-agent-runtime PoC against its package-boundary and execution-realm invariants. Use after adding a package export, moving a file between packages, adding a cross-package import, or touching an Expo plugin or worker entry — and before calling such a change done.
---

# Boundary Review

Reviews a change for **architectural boundary violations only**. Correctness, security,
and performance are separate concerns — do not fold them in here.

This PoC exists to prove that a set of package boundaries holds. A change that quietly
erodes one defeats the purpose of the workspace, and no test will catch it, because
everything still runs.

## 1. Gather

Read `AGENTS.md` in the workspace root — sections "Package boundaries" and "Execution
realms" are the invariants under review. Then get the change:

```sh
git diff --stat $(git merge-base HEAD main)...HEAD -- .
```

Read the touched packages' `package.json` (`exports`, `imports`, `dependencies`) and any
relevant `docs/arch/` record for the boundary the change claims to respect.

## 2. Hunt the failure mode

For each invariant, look for its concrete violation:

| Invariant | Violation looks like |
|---|---|
| `assistant` owns facade + lifecycle | Transport or tool-policy decisions leaking in |
| `sync` owns identity + state | Anything that runs an agent or a tool |
| `harness` owns *generic* execution | A concrete skill, a skill name, or product policy inside `packages/` |
| `agents` is transport-free | Any import that does I/O, storage, or networking |
| `supervisor` is lifecycle mechanics | Product policy — or TypeScript, since it is intentionally plain JS |
| `config` is a key-agnostic leaf | A specific key's name, aliases, default, or allowed values landing in `packages/config` instead of being declared with `defineConfigKey` by the owning package; a snapshot installed after loggers or runtime services are built |
| Skills belong to applications | Skill-specific branching moved out of `apps/skill-cli` |
| Sync and Harness are siblings | A **new** `@qvac/sync` import in `packages/harness` — including a type-only one. State must reach Harness through its `StatePort` and an injected client. The four existing sites are tracked debt (see AGENTS.md); a fifth is a blocker |
| Sync/Harness independently adoptable | A change that makes `bun run test:pack`'s Sync-only or Harness-only consumer non-viable — a blocker even if the suite is not run |
| Dependency direction | A new edge reversing an arrow, or any cycle |
| Realm correctness | A new `node:*` import in shared or Bare-reachable code, `Buffer` where `b4a` belongs, a new export whose `react-native` condition was not considered |

## 3. Report

For each finding: the invariant broken, the file and line, why the current tests still
pass despite it, and the smallest change that restores the boundary. Order by severity.
If a boundary is intact but the change made it load-bearing in a new way, say so
explicitly rather than silently approving.

If nothing is wrong, say so plainly and name the invariants actually checked against the
diff. Do not invent findings to appear thorough.
