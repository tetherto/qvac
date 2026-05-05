---
name: pr-test
description: Plan and run local PR validation for tetherto/qvac PRs. Reuses the shared PR worktree, discovers touched packages and package.json scripts, recommends a test tier, and analyzes results. Use when testing a PR or invoking /pr-test.
disable-model-invocation: true
---

# PR Test

Manual-trigger local PR validation for any GitHub PR in `tetherto/qvac`.

The skill prepares an isolated PR worktree, discovers changed packages and test options, recommends a tier, and then runs or proposes the selected validation steps according to package type.

High-level flow:

1. Discover package-local setup, examples, tests, and related validation targets from committed PR state.
2. Present a recommended tier plus any related examples/tests as part of the same proposal.
3. Execute agent-owned steps inside the isolated PR worktree when safe.
4. For validation that must be user-run, print exact commands and inspect reports/logs afterward.

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

For every selected tier, agent-owned package validation must prepare the touched package root before examples or non-e2e tests run. If discovery reports `commands.install` or `commands.build`, include those setup commands first in the proposed command plan and execute them first from the package `cwd`.

## Workflow

Track this checklist:

```text
- [ ] 0a. Prepare worktree with worktree-prepare.mjs
- [ ] 0b. Discover packages/scripts/tests with pr-test-discover.mjs
- [ ] 1. Present recommendation and tier menu
- [ ] 2. Ask user to select tier and mobile platform when needed
- [ ] 3. Print proposed command sequence
- [ ] 4a. Run agent-owned setup/examples when safe and applicable
- [ ] 4b. If SDK e2e is included: stop and ask user to run the printed tests-qvac setup + e2e command block
- [ ] 4c. If SDK e2e is not included: ask approval, then execute remaining commands
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
PATCH_PATH=<absolute path to patch>
BASE_REF=<remote>/<baseRefName>
```

If stderr contains `WORKTREE_FALLBACK=<reason>`, use fallback mode:

- Fetch/read files via GitHub API if needed.
- Let `pr-test-discover.mjs` fetch the patch with `gh pr diff --patch` into the platform temp directory when `PATCH_PATH` is unavailable.
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
- `touchedPackages[].exampleCommands`
- `touchedPackages[].relatedExampleCommands`
- `touchedPackages[].addedOrModifiedTests`
- `touchedPackages[].relatedTests`
- SDK-only `sdkE2eSetup`

Discovery is based on committed PR state only. Do not run `git diff`, `git status`, or `git ls-files --modified` inside the worktree for classification.

Use `touchedPackages[].commands.install` and `touchedPackages[].commands.build` as package-root setup steps for all executable tiers. These setup commands belong before changed examples, related examples, non-SDK tests, or SDK manual e2e command blocks.

## Tier Ladder

All tiers include necessary install/build setup for the touched package roots.

- **T1 - examples**: run package-root install/build setup, then added/modified examples. If no examples were added or modified, mark the examples step `not applicable`.
- **T2 - changed e2e/tests on desktop**: SDK runs changed `tests-qvac` e2e on desktop. Non-SDK runs the smallest unit-level package script (`test:unit` or `test`), or first available `test:*`.
- **T3 - changed e2e/tests on mobile**: SDK adds changed e2e on selected mobile platform (`android` or `ios`). Non-SDK uses mobile scripts only if package.json exposes them.
- **T4 - smoke desktop**: SDK runs `--suite smoke` on desktop. Non-SDK advances to the next least-to-most-complete script if one exists.
- **T5 - smoke mobile**: SDK runs `--suite smoke` on selected mobile platform. Non-SDK uses mobile scripts only if package.json exposes them.
- **T6 - full desktop**: SDK runs the full desktop suite. Non-SDK runs `test:all` if present, otherwise all applicable `test:*` scripts in increasing completeness order.
- **T7 - full mobile**: SDK runs the full selected mobile suite. Non-SDK uses mobile/full scripts only if package.json exposes them.

T2 and every higher tier are additive over T1. If `exampleCommands` is non-empty, the proposed command plan for T1/T2/T3/T4/T5/T6/T7 MUST include package-root install/build setup first, then every changed example command before the e2e/smoke/full test command. Do not summarize examples as "applicable" without emitting runnable commands. Changed helper files under examples, such as `shared.ts` or `utils.ts`, should be listed as supporting files but not emitted as runnable commands.

Related examples and tests are bundled into the existing tiers as proposal items, not separate options:

- `relatedExampleCommands` are examples that appear semantically related to the changed paths. Prefer safe examples first: no obvious required input/device and no obvious output-file generation. Present them after changed examples as "related examples proposed by discovery", and let the user deselect them before agent execution.
- `relatedTests` are existing SDK e2e filters related to the changed paths. If no e2e files changed, use the highest-scoring related filter as the proposed T2 filter. If e2e files did change, show related filters as optional additions.
- Example: a transcription SDK change should propose transcription examples and the `transcription` e2e filter even if the PR did not edit those files directly.

Changed examples are agent-run steps after package-root install/build setup succeeds. SDK `tests-qvac` setup is **not** agent-run; hand it to the user together with the e2e command because it requires npm auth.

T6/T7 replace the smoke step from T4/T5. T1-T3 still run unchanged.

## Recommendation policy

Always show the recommendation before the tier prompt. The user can override it.

- **SDK (`packages/sdk`) default**: recommend **T2**. This covers install/build, changed examples if present, and changed e2e on desktop. Mobile is opt-in because it is slower and usually covered by CI.
- **Non-SDK default**: recommend the smallest tier that includes at least unit-level validation. Usually T2.
- **No examples**: if no changed or related examples are discovered, mark examples `not applicable`.
- **No tests discovered**: recommend install/build only and ask the user to confirm build-only validation.
- **Mixed PRs**: recommend the highest minimum required by any touched package. Example: SDK + addon changes means SDK T3 plus addon unit scripts.

Use `AskQuestion` for tier selection. Ask for `android` or `ios` only when the recommended or selected tier includes mobile (`T3`, `T5`, or `T7`).

The tier prompt MUST include `T1` whenever `exampleCommands` or `relatedExampleCommands` is non-empty, even when the recommended tier is higher. Do not hide lower additive tiers. If examples are absent, show T1 as `not applicable` or omit it with an explicit "no changed or related examples" note in the plan.

Before executing examples, show both changed and related example commands. Related examples are proposed, not mandatory; use `AskQuestion` to let the user choose which related examples to include when any are present.

## SDK-specific handling

SDK changed examples may be agent-run inside the prepared worktree after the SDK package root has been installed and built.

SDK `tests-qvac` setup and e2e commands are manual/user-run:

- `npm run install:build`
- `npm run install:build:full`
- `npx qvac-test run:local:*`

Do not execute those agentically. `tests-qvac` setup needs npm/GitHub Packages auth that is not available in the agent context, and SDK e2e commands are device/broker-dependent and may run for a long time.

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

For SDK e2e tiers, print the `tests-qvac` setup command and e2e command for the user to run manually. The agent must not run `npm run install:build`, `npm run install:build:full`, or `npx qvac-test run:local:*` from `packages/sdk/tests-qvac`.

Generate commands for the user's shell/OS. Do not assume POSIX-only utilities or paths. In particular:

- Use paths emitted by the discovery manifest; they are platform-specific.
- Use `mkdir -p` only for POSIX shells. For PowerShell, use `New-Item -ItemType Directory -Force`.
- Prefer environment variable syntax for the user's shell (`export NAME=...` for POSIX, `$env:NAME = "..."` for PowerShell).
- If unsure which shell the user will run manually, provide both POSIX and PowerShell variants.

Run ID format:

```text
pr-<num>-<headSha7>-<tier>-<platform-or-desktop>
```

Report directory:

```text
<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/<runId>/
```

Manual command block shape for POSIX shells:

```sh
export QVAC_PR_TEST_RUN_ID=pr-1234-abcdef0-t3-android
export QVAC_PR_TEST_REPORT_DIR=<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/$QVAC_PR_TEST_RUN_ID
mkdir -p $QVAC_PR_TEST_REPORT_DIR/logs

cd <WORKTREE_PATH>/packages/sdk/tests-qvac
npm run install:build:full

npx qvac-test run:local:desktop --filter vision- --runId $QVAC_PR_TEST_RUN_ID --report-dir $QVAC_PR_TEST_REPORT_DIR
npx qvac-test run:local:android --filter vision- --runId $QVAC_PR_TEST_RUN_ID --report-dir $QVAC_PR_TEST_REPORT_DIR
```

Manual command block shape for PowerShell:

```powershell
$env:QVAC_PR_TEST_RUN_ID = "pr-1234-abcdef0-t3-android"
$env:QVAC_PR_TEST_REPORT_DIR = "<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/$env:QVAC_PR_TEST_RUN_ID"
New-Item -ItemType Directory -Force "$env:QVAC_PR_TEST_REPORT_DIR/logs"

Set-Location "<WORKTREE_PATH>/packages/sdk/tests-qvac"
npm run install:build:full

npx qvac-test run:local:desktop --filter vision- --runId $env:QVAC_PR_TEST_RUN_ID --report-dir $env:QVAC_PR_TEST_REPORT_DIR
npx qvac-test run:local:android --filter vision- --runId $env:QVAC_PR_TEST_RUN_ID --report-dir $env:QVAC_PR_TEST_REPORT_DIR
```

Agent-owned SDK setup and changed-example command shape for POSIX shells:

```sh
cd <WORKTREE_PATH>/packages/sdk
bun install
bun run build
bun run examples/<changed-example>.ts
```

Agent-owned SDK setup and changed-example command shape for PowerShell:

```powershell
Set-Location "<WORKTREE_PATH>/packages/sdk"
bun install
bun run build
bun run examples/<changed-example>.ts
```

The user runs the `tests-qvac` setup command and the `qvac-test run:local:*` commands. The agent may run changed examples separately only after the required SDK package-root install/build state exists or has been prepared without `tests-qvac` npm auth.

Do not use `script` for log capture. It is not portable in this agent environment. For agent-run example steps, rely on terminal output. For user-run setup/e2e, rely on qvac-test's structured `--report-dir` output first; ask the user to paste terminal output only if setup fails before report files are produced or report files are missing/incomplete. Keep the `--runId` unchanged.

When the user says the commands finished:

1. Inspect `<WORKTREE_PATH>/packages/sdk/tests-qvac/reports/<runId>/` first. Prefer qvac-test's structured report files over terminal logs.
2. Read supplemental terminal output only if the agent captured any for setup/example steps, or ask the user to paste terminal output if report files are missing/incomplete.
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
<platform temp dir>/qvac-pr-test/pr-<num>/<package-name-or-path>/<step>.log
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

Changed examples:
- `<path>` - runnable/not runnable

Related examples proposed:
- `<path>` - safe/needs input/writes output, include by default? <yes/no>

Related e2e filters proposed:
- `<filter>` - why

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
- Generic discovery helpers: `.cursor/skills/_lib/pr-skills/pr-test-generic.mjs`
- SDK-specific discovery heuristics: `.cursor/skills/_lib/pr-skills/pr-test-sdk.mjs`
- Shared worktree library: `.cursor/skills/_lib/pr-skills/worktree.mjs`
- SDK e2e rules: `.cursor/rules/sdk/tests-qvac.mdc`
- SDK e2e scripts: `packages/sdk/tests-qvac/package.json`
- SDK e2e docs: `packages/sdk/tests-qvac/README.md`
