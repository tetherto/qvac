---
name: pr-test
description: Plan and run local PR validation for tetherto/qvac PRs. Reuses the shared PR worktree, discovers touched packages and package.json scripts, recommends a test tier, prints manual SDK e2e commands with fixed runId/report-dir, and analyzes results. Use when testing a PR or invoking /pr-test.
disable-model-invocation: true
---

# PR Test

Manual-trigger local PR validation for any GitHub PR in `tetherto/qvac`.

The skill prepares an isolated PR worktree, discovers changed packages and test options, recommends a tier, and either:

1. Executes non-SDK-e2e commands after user approval.
2. Prints SDK e2e commands for the user to run manually with a fixed `runId` and `--report-dir`, then analyzes reports/logs after the user reports completion.

## When to use this skill

Use when:

- User asks to test a PR or provides a PR URL for validation.
- User invokes `/pr-test`.
- A PR review/status flow needs local verification before reviewers are pinged.

## Inputs

- **Required**: PR URL, e.g. `https://github.com/tetherto/qvac/pull/1234`.
- **Optional**: user focus area, preferred mobile platform (`android` or `ios`), desired tier.

If PR URL is missing, ask for it. Do not ask other questions until discovery has produced a concrete recommendation.

## Safety rules

This skill must not touch the user's local working tree.

Forbidden against the user's main repo:

- `git switch`, `git checkout`, `git reset`, `git restore`
- `git stash`, `git pull`, `git merge`, `git rebase`, `git cherry-pick`
- `git clean`
- `gh pr checkout`
- Any package manager, build, or test command

### Worktree carve-out

The shared script `worktree-prepare.mjs` is allowed to operate only inside `~/.cache/qvac-pr-review/pr-<num>/`. It may fetch PR refs, add/remove worktrees, reset tracked files, and clean untracked artifacts on SHA drift.

The agent may run non-e2e package manager/build/test commands only inside the prepared worktree path printed by `worktree-prepare.mjs`.

SDK e2e commands are device/broker-dependent and may run for a long time. Do **not** execute SDK e2e commands agentically. Print a manual command block instead.

## Workflow

Track this checklist:

```text
- [ ] 0a. Prepare worktree with worktree-prepare.mjs
- [ ] 0b. Discover packages/scripts/tests with pr-test-discover.mjs
- [ ] 1. Present recommendation and tier menu
- [ ] 2. Ask user to select tier and mobile platform when needed
- [ ] 3. Print proposed command sequence
- [ ] 4a. If SDK e2e is included: stop and ask user to run manual command block
- [ ] 4b. If SDK e2e is not included: ask approval, then execute commands
- [ ] 5. Analyze logs/reports
- [ ] 6. Summarize pass/fail and next action
```

### 0a. Prepare worktree

Run:

```bash
node .cursor/skills/_lib/pr-skills/worktree-prepare.mjs <PR-URL>
```

Parse stdout:

```text
WORKTREE_PATH=<absolute path>
HEAD_SHA=<sha>
PATCH_PATH=/tmp/pr-<num>.patch
BASE_REF=<remote>/<baseRefName>
```

If stderr contains `WORKTREE_FALLBACK=<reason>`, use fallback mode:

- Fetch/read files via GitHub API if needed.
- Let `pr-test-discover.mjs` fetch `/tmp/pr-<num>.patch` with `gh pr diff --patch`.
- Tell the user that worktree preparation failed and local command execution is unavailable unless they want to retry.

### 0b. Discover test options

Run:

```bash
node .cursor/skills/_lib/pr-skills/pr-test-discover.mjs <PR-URL> --worktree <WORKTREE_PATH> --head-sha <HEAD_SHA> --patch <PATCH_PATH>
```

The helper emits a JSON manifest with:

- `recommendation.recommendedTier`
- `recommendation.recommendationReason`
- `touchedPackages[]`
- `touchedPackages[].scripts`
- `touchedPackages[].commands`
- `touchedPackages[].addedOrModifiedExamples`
- `touchedPackages[].addedOrModifiedTests`
- SDK-only `sdkE2eSetup`

Discovery is based on committed PR state only. Do not run `git diff`, `git status`, or `git ls-files --modified` inside the worktree for classification.

## Tier Ladder

All tiers include necessary install/build setup for the touched packages.

- **T1 - examples**: run added/modified examples only. If no examples were added or modified, mark this step `not applicable`.
- **T2 - changed e2e/tests on desktop**: SDK runs changed `tests-qvac` e2e on desktop. Non-SDK runs the smallest unit-level package script (`test:unit` or `test`), or first available `test:*`.
- **T3 - changed e2e/tests on mobile**: SDK adds changed e2e on selected mobile platform (`android` or `ios`). Non-SDK uses mobile scripts only if package.json exposes them.
- **T4 - smoke desktop**: SDK runs `--suite smoke` on desktop. Non-SDK advances to the next least-to-most-complete script if one exists.
- **T5 - smoke mobile**: SDK runs `--suite smoke` on selected mobile platform. Non-SDK uses mobile scripts only if package.json exposes them.
- **T6 - full desktop**: SDK runs the full desktop suite. Non-SDK runs `test:all` if present, otherwise all applicable `test:*` scripts in increasing completeness order.
- **T7 - full mobile**: SDK runs the full selected mobile suite. Non-SDK uses mobile/full scripts only if package.json exposes them.

T6/T7 replace the smoke step from T4/T5. T1-T3 still run unchanged.

## Recommendation policy

Always show the recommendation before the tier prompt. The user can override it.

- **SDK (`packages/sdk`) default**: recommend **T2**. This covers install/build, changed examples if present, and changed e2e on desktop. Mobile is opt-in because it is slower and usually covered by CI.
- **Non-SDK default**: recommend the smallest tier that includes at least unit-level validation. Usually T2.
- **No examples**: do not recommend T1 just to run examples. Mark examples `not applicable`.
- **No tests discovered**: recommend install/build only and ask the user to confirm build-only validation.
- **Mixed PRs**: recommend the highest minimum required by any touched package. Example: SDK + addon changes means SDK T3 plus addon unit scripts.

Use `AskQuestion` for tier selection. Ask for `android` or `ios` only when the recommended or selected tier includes mobile (`T3`, `T5`, or `T7`).

## SDK e2e setup

For any SDK e2e command, run setup from `packages/sdk/tests-qvac` first.

- SDK source outside `packages/sdk/tests-qvac/` changed:

  ```bash
  npm run install:build:full
  ```

- Only `packages/sdk/tests-qvac/` changed:

  ```bash
  npm run install:build
  ```

Do not skip setup based on assumed previous state. The PR worktree is treated as clean/synchronized, and SDK e2e validation must prepare the test package explicitly.

Do not separately run `bun install` or `bun run build` in `packages/sdk` before SDK e2e unless the chosen tier also includes non-e2e SDK example validation that specifically needs it.

## SDK e2e manual execution

SDK e2e commands must be printed for the user to run manually.

Run ID format:

```text
pr-<num>-<headSha7>-<tier>-<platform-or-desktop>
```

Report directory:

```text
<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/<runId>/
```

Command block shape:

```bash
cd <WORKTREE_PATH>/packages/sdk/tests-qvac
export QVAC_PR_TEST_RUN_ID=pr-1234-abcdef0-t3-android
export QVAC_PR_TEST_REPORT_DIR=reports/$QVAC_PR_TEST_RUN_ID
mkdir -p $QVAC_PR_TEST_REPORT_DIR/logs

script -q $QVAC_PR_TEST_REPORT_DIR/logs/install.log npm run install:build:full
script -q $QVAC_PR_TEST_REPORT_DIR/logs/desktop.log npx qvac-test run:local:desktop --filter vision- --runId $QVAC_PR_TEST_RUN_ID --report-dir $QVAC_PR_TEST_REPORT_DIR
script -q $QVAC_PR_TEST_REPORT_DIR/logs/android.log npx qvac-test run:local:android --filter vision- --runId $QVAC_PR_TEST_RUN_ID --report-dir $QVAC_PR_TEST_REPORT_DIR
```

If `script` is unavailable or the user's shell rejects that form, ask the user to run the same commands without `script` and paste the output. Keep the `--runId` unchanged.

When the user says the commands finished:

1. Inspect `<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/<runId>/` first. Prefer qvac-test's structured report files over terminal logs.
2. Read supplemental logs under `<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/<runId>/logs/` only when needed to explain install failures, runner crashes, device/broker errors, or missing report files.
3. Summarize failures first, then passes and skipped/not-applicable steps.

## Non-SDK execution

For non-SDK packages, show the proposed command list and ask for approval before execution.

Each step must show:

- `cwd`
- command
- why it is included
- expected log path

Run commands one at a time inside the worktree. Capture logs to:

```text
/tmp/qvac-pr-test/pr-<num>/<package-name-or-path>/<step>.log
```

Abort on first non-zero exit unless the user explicitly opted into continuing after failures.

## Output format

Before executing or asking the user to run anything, print:

```markdown
## PR #<num> - test plan

Recommended tier: <tier>
Reason: <short reason>

Touched packages:
- `<path>` - <kind>, <summary of scripts/examples/tests>

Proposed commands:
1. `<cwd>` - `<command>` - <why>

Manual-run required:
<yes/no; if yes, explain SDK e2e must be run by user>
```

After execution or log analysis, print:

```markdown
## PR #<num> - test results

### Failed
<failures first, with log file paths and short error snippets>

### Passed
<passed steps>

### Not applicable
<examples/tests/mobile tiers skipped because absent>

Logs: `<path>`
```

## References

- Shared worktree prep: `.cursor/skills/_lib/pr-skills/worktree-prepare.mjs`
- Discovery helper: `.cursor/skills/_lib/pr-skills/pr-test-discover.mjs`
- Shared worktree library: `.cursor/skills/_lib/pr-skills/worktree.mjs`
- SDK e2e scripts: `packages/sdk/tests-qvac/package.json`
- SDK e2e docs: `packages/sdk/tests-qvac/README.md`
