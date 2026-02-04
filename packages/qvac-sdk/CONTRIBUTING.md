# Contributing to QVAC SDK

Welcome to the QVAC SDK! This document outlines our contribution guidelines designed to establish **high trust, high velocity, and high reliability** development practices.

## 🎯 Core principles

**The purpose of each contribution should be to solve a specific problem, not to add code to the SDK.**

Our aim should always be to **simplify, reduce, minimize**. Verbosity is our enemy. Every line of code is a liability - it must be maintained, debugged, understood, and potentially refactored.

**The best code is the code you don't write. The second best is the code you delete.**

If you manage to solve a problem by removing code, that gives you double points - it shows you actually understood what the problem and found the most optimal solution, which is always to delete code rather than add it.

**Code reduction** is often the most ignored metric, even though it's the best predictor of quality and lack of bugs.

**The worst error a smart engineer can make** is to optimize something that shouldn't exist.

**Sources:**

- [The Best Code is No Code At All](https://blog.codinghorror.com/the-best-code-is-no-code-at-all/) - Jeff Atwood
- [Question Every Requirement](https://www.youtube.com/watch?v=hhuaVsOAMFc) - On avoiding the trap of optimizing things that shouldn't exist
- [Code Reduction as Quality Predictor](https://www.youtube.com/watch?v=Rpaat8WFqxY) - Evidence that reducing code is the best predictor of codebase quality

## ✅ Contribution rules

- **Never break user space.** Do not change exposed APIs unless adding user-facing capability or simplification. Do not adjust APIs to solve internal implementation issues.
- **Keep changes surgical.** Each PR solves exactly one problem or delivers one feature. If you find related work, open/link separate PRs. Localize complexity instead of spreading risk.
- **Enforce type safety.** No `any` on the client; server-side coercion only when necessary for Bare types. Avoid `unknown` unless required for RPC bridges. Avoid `@ts-ignore` or eslint disables except in rare, justified cases.
- **Keep client portable.** All platform-specific logic belongs on Bare/server. The client should remain an RPC client that can be ported to other environments.
- **Prefer the simplest solution.** After implementing, ask if it can be simpler. Delete code when it clarifies behavior.

## 🚀 Quickstart (fast lane)

- `nvm use` and `bun install`
- Run `bun lint` then `bun test` before opening a PR (husky hooks will enforce these on commit)
- Keep PRs focused on one change; draft early if work is in progress
- Follow commit format `prefix[tags]?: subject` (e.g., `fix: tighten cache validation`)

## 🛣️ Contribution lanes

- **Small change fast lane:** Typos, docs tweaks, minor refactors/tests. Fork, install, lint/test, open a PR.
- **Feature/bug lane:** For behavioral changes, add a short design note in the PR description (problem, approach, alternatives) and include tests.

## 🏷️ Issues and labels

- Look for `good first issue` or `help wanted`.
- Comment to claim an issue; add a brief plan if work is non-trivial.
- If you find related issues while working, open or link them instead of expanding scope.

## 🆘 Asking for help

- Use Discussions/Issues for blocking questions.
- Include platform/runtime, version info, reproduction steps, logs, and what you already tried.

## ✅ Pull request requirements

- Lint and tests pass (`bun lint`, `bun test`).
- PR covers exactly one problem/feature; related items go to separate PRs.
- Commit message follows `prefix[tags]?: subject`; PR title follows the ticket format with tags when applicable.
- Add tests for any behavior change (or explain why not).
- Note breaking or API-affecting changes with `[bc]` or `[api]` tags and include required code examples in the PR body.

## 🧪 Testing expectations

- New features and bug fixes need at least one test.
- Prefer small, focused tests over broad fixtures.
- Keep tests platform-aware: client code must stay portable; server/Bare code can use Bare-specific utilities.

## 📐 Design notes and decisions

- For changes with material design impact, add a short note (problem, options considered, decision).
- Keep dependencies minimal; prefer builtin/bare equivalents before adding libraries.
- Favor function-based, low-abstraction solutions; delete code when it simplifies behavior.

## 🧾 Developer Certificate of Origin (DCO)

We require a DCO 1.1 sign-off on every commit. By signing off you certify that you wrote the code or otherwise have the right to pass it on under the license.

- Add a `Signed-off-by: Your Name <your.email@example.com>` line to every commit. The simplest way is `git commit -s ...`.
- The sign-off name and email must match the commit author and reflect your real identity.
- If you amend or rebase, keep the sign-off lines intact (`git commit --amend --no-edit -s`).
- For co-authored work, each author should add their own `Signed-off-by` line.
