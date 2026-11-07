---
name: qv-ci-contract
description: Change CI for a package tagged ci:addons, add a package to the CI contract, or write or change an action the contract's groups call. Use when a task touches a tagged package's build, test, mobile or publish CI, a native provider such as fabric, the contract's groups (pr-checks, pr-build-test, mobile-tests, cache-warm, publish-npm, publish-gpr, the _*.yml templates), select-projects.mjs, or gives a package native CI.
---

# qv-ci-contract

The standard is [`docs/ci/workflow-standard.md`](../../../docs/ci/workflow-standard.md): target names, configurations, metadata, native dependencies, prebuilds and trust. Read it before any of the three tasks below; this skill is the procedure, not the rules.

Pick the task:

1. A tagged package's CI changes: [Change CI for a package](#1-change-ci-for-a-package).
2. A package joins the contract: [Add a package](#2-add-a-package).
3. A shared step is added or changed: [Write or change an action](#3-write-or-change-an-action).

## 1. Change CI for a package

1. Confirm the tag: `pnpm exec nx show projects --projects tag:ci:addons`. An untagged package is not on the contract; follow `.github/AGENTS.md` instead and stop here.
2. Put the change in the package's own files:
   - a command: a target command in `project.json`, or a script in the package's `ci/` directory that a target runs;
   - platform flags: the platform configuration's `args`;
   - a step that differs on one platform: that configuration's `commands`;
   - a runner: the configuration's `ci.runner` key from `reusable-runner-names.yml`;
   - a toolkit: the configuration's `ci.setup`;
   - a timeout, mobile setting or release tag prefix: the target's `metadata`;
   - models: the package's model manifest.
3. Leave the workflows and actions alone. A package name or directory never appears in a condition there. If the standard cannot express the change, that is a change to the standard: raise it before writing it.
4. Run `node --test .github/scripts/test/ci-contract-standard.test.mjs .github/scripts/test/ci-trust-policy.test.mjs`, and run the target locally where the host allows: `pnpm exec nx run <project>:<target>:<configuration>`.

Done when both test files pass and the target runs locally, or the change is confirmed in a `pr-build-test.yml` run on the branch.

## 2. Add a package

One pull request adds the package. When it replaces a workflow of its own, before it merges only that workflow runs, after it merges only the contract does, and reverting it restores the workflow with no other edit. `main` is the source of truth: port its runners, flags, system packages, timeouts and dormant settings as they are.

1. Tag the package `ci:addons` in its `project.json`.
2. Map every step its CI runs to a standard target, with a configuration per platform on the runner the old job used.
3. Depend on each native dependency's `link:platform` by name. Give the dependency a `link:platform` target if it lacks one. A dependency on the contract builds first as a provider, so it needs a build configuration for every configuration the package builds or lints, and the package's ranges on it must include its workspace version.
4. Move scripts the targets call into the package's `ci/` directory, and models into its manifest.
5. For mobile, set `metadata.mobile` and map the Device Farm project in `DEVICEFARM_PROJECTS` (`select-projects.mjs`) and `PROJECT_ARN` (`_mobile.yml`).
6. Wire Merge Guard as `docs/ci/MERGE-GUARD.md` says: a `packages/<dir>/**`-only filter entry, `ALL_PACKAGES`, the status keys, and the package's producer in `CARVED_OUT_PRODUCERS` set to `pr-build-test.yml`. The status contexts stay the same.
7. Delete the package's own workflows, and limit edits to shared files to letting go of them.
8. Point the package's npm trusted publisher at `publish-npm.yml`, so only one workflow can publish it.
9. Rehearse on the branch: `pr-checks`, `pr-build-test` with the `prebuilds`, `run-cpp-addon-tests` and `run-desktop-addon-tests` labels, `cache-warm`, `mobile-tests` on one Android and one iOS device one after the other (dispatches on one branch cancel each other), `publish-npm` with `dry_run`, and `publish-gpr`. Compare each with the old path on the same commit, and compare the prebuilds binary by binary.
10. Stop before anything leaves the machine. Show the full diff and wait for approval before a push, a dispatch or a pull request, and get a separate yes before creating the pull request.

Done when the standard test passes for the package, every rehearsal run is green with each difference from the old path explained, and the diff is approved.

## 3. Write or change an action

1. Decide where the step lives:
   - most packages that run the target need it: an action;
   - fewer than half do: a script in each package's `ci/` directory, run by its target;
   - nothing in it is qvac's: a generic action in `tetherto/qvac-actions`, pinned by SHA from qvac, with every qvac value passed as an input;
   - otherwise: `.github/actions/<name>/` in this repository.
2. Keep it lean: one job per action, named `setup-<tool>` for an installer, the wrapped action's name for a wrapper, and area first otherwise (`devicefarm-wait-runs`); `action.yml` at most 60 lines with longer logic in a script beside it; no local `uses:` inside it; no credentials or secret reads (the job sets credentials up and passes values in); third-party actions only through their one pinned wrapper.
3. Add a lean version beside an old action under a new name, and delete the old one in the change that removes its last caller.
4. Run actionlint on the calling workflows and the repository's policy tests.

Done when actionlint and the policy tests pass, and the action is used by a contract workflow run on the branch.
