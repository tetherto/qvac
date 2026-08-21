# SDK npm Peer-Resolution Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing SDK Pod Checks reject npm-incompatible `packages/sdk` dependency trees while preserving the complete Bun validation pipeline.

**Architecture:** Keep all behavior in the existing `SDK Pod Checks` job and its failure accumulator. Add one explicit workspace npm-install helper for `sdk`, then harden the packaged-consumer helper so every scenario and setup failure reaches the job result.

**Tech Stack:** GitHub Actions YAML, Bash, npm, Bun, actionlint, GitHub CLI.

## Global Constraints

- Keep the single required job name `SDK Pod Checks`; add no job or required status.
- Run npm against the committed `packages/sdk/package.json` before source-specific setup.
- Treat a non-zero npm exit, `ERESOLVE`, `npm warn peer`, or `npm warn peerOptional` as failure.
- Remove npm-created `node_modules` and `package-lock.json` before the existing Bun install.
- Preserve the existing `.npmrc`, Bun install, lint, typecheck, build, unit, Bare, e2e, contract, packaging, and consumer checks.
- Run both default and lean packaged-consumer scenarios and fail if either fails.
- Do not modify dependency versions or public SDK behavior.
- Do not stage the unrelated `.cursor/skills/qv-sdk-e2e-report/` or `.cursor/skills/qv-sdk-openai-coverage-report/` directories.

---

### Task 1: Make Packaged-Consumer Failures Sticky

**Files:**
- Modify: `.github/workflows/pr-checks-sdk-pod.yml:227-300`

**Interfaces:**
- Consumes: existing `consumer_install_check` and `check_consumer <directory> <label>` Bash functions.
- Produces: `consumer_install_check` returns non-zero when setup, install, warning scan, invariant validation, or import validation fails in either scenario.

- [ ] **Step 1: Capture the failing baseline**

Run:

```bash
gh run view 32306783750 --repo tetherto/qvac --job 96241239077 --log
```

Expected evidence in the log:

```text
::error::[default] hyperdb resolved to 3 copies (expected 1)
ok  [sdk] consumer install
All SDK pod checks passed.
```

This demonstrates that the default scenario failed but the later lean scenario
overwrote the function's effective return status.

- [ ] **Step 2: Replace implicit `errexit` propagation with scenario aggregation**

In `consumer_install_check`, initialize an aggregate immediately before the
default scenario:

```bash
            consumer_fail=0
```

Wrap both installs and both `check_consumer` calls:

```bash
            if ! npm install --no-fund --no-audit --ignore-scripts --loglevel=info "$tarball_abs" 2>&1 | tee install.log; then
              echo "::error::[default] npm install failed"
              consumer_fail=1
            fi
            if ! check_consumer "$consumer_default" "default"; then
              consumer_fail=1
            fi
```

```bash
            if ! npm install --no-fund --no-audit --ignore-scripts --omit=optional --loglevel=info "$tarball_abs" 2>&1 | tee install.log; then
              echo "::error::[lean (--omit=optional)] npm install failed"
              consumer_fail=1
            fi
            if ! check_consumer "$consumer_lean" "lean (--omit=optional)"; then
              consumer_fail=1
            fi

            [ "$consumer_fail" = "0" ]
```

Call the function outside a conditional so its internal `set -e` remains
effective for setup failures, then inspect the captured status:

```bash
              consumer_install_check
              consumer_status=$?
              if [ "$consumer_status" -eq 0 ]; then
                echo "  ok  [$PKG] consumer install"
              else
                echo "::error::[$PKG] consumer install check failed"
                fail=$((fail + 1))
              fi
```

- [ ] **Step 3: Run structural validation**

Run:

```bash
actionlint .github/workflows/pr-checks-sdk-pod.yml
```

Expected: exit code `0`, no output.

Run:

```bash
node .github/scripts/lint-workflows.mjs .github/workflows/pr-checks-sdk-pod.yml
```

Expected: exit code `0`.

- [ ] **Step 4: Review the focused diff**

Run:

```bash
git diff --check
git diff -- .github/workflows/pr-checks-sdk-pod.yml
```

Expected: no whitespace errors; only consumer failure propagation changes.

- [ ] **Step 5: Commit the consumer hardening**

```bash
git add .github/workflows/pr-checks-sdk-pod.yml
git commit -m "fix: propagate SDK consumer install failures"
```

### Task 2: Add the SDK Workspace npm Peer Check

**Files:**
- Modify: `.github/workflows/pr-checks-sdk-pod.yml:210-220,319-367`

**Interfaces:**
- Consumes: package loop variables `PKG`, `P_PATH`, `WS`, existing `run <label> <command...>` accumulator, and copied `.npmrc`.
- Produces: `sdk_npm_install_check` returning an explicit npm/peer-warning status without aborting later Bun checks.

- [ ] **Step 1: Reproduce the historical npm mismatch**

Create an isolated worktree at the historical PR head:

```bash
git worktree add /tmp/qvac-23901-peer-repro origin/pr-3952-head
```

Run in `/tmp/qvac-23901-peer-repro/packages/sdk`:

```bash
npm install --no-fund --no-audit --ignore-scripts --loglevel=info
```

Expected: non-zero `ERESOLVE` or a peer warning containing
`@qvac/registry-client@^0.4.0` and the SDK's `@qvac/registry-client@^0.6.1`.

Remove the isolated worktree after recording the result:

```bash
git worktree remove /tmp/qvac-23901-peer-repro
```

- [ ] **Step 2: Add the explicit npm-install helper**

Add immediately after the existing `run()` helper:

```bash
          sdk_npm_install_check() {
            local log status
            log=$(mktemp)
            status=0

            npm install --no-fund --no-audit --ignore-scripts --loglevel=info 2>&1 | tee "$log" || status=$?

            if grep -Eq 'ERESOLVE|npm warn (peerOptional|peer)( |$)' "$log"; then
              echo "::error title=SDK npm peer-resolution drift::npm install surfaced peer dependency errors or warnings"
              grep -E 'ERESOLVE|npm warn (peerOptional|peer)( |$)' "$log" || true
              status=1
            fi

            rm -f "$log"
            return "$status"
          }
```

The explicit `status` is required because the helper is invoked through the
existing `run()` conditional, where Bash `errexit` cannot be relied upon.

- [ ] **Step 3: Invoke npm once before source-specific SDK setup**

After copying `.npmrc` into the selected package directory and before the
disallowed-dependency/source loops, add:

```bash
            if [ "$PKG" = "sdk" ]; then
              run "npm install (peer resolution)" sdk_npm_install_check
              run "npm install cleanup" rm -rf node_modules package-lock.json
            fi
```

This keeps the npm tree from influencing the subsequent existing
`bun install`.

- [ ] **Step 4: Verify the current SDK tree succeeds**

Run in `packages/sdk`:

```bash
npm install --no-fund --no-audit --ignore-scripts --loglevel=info
```

Expected: exit code `0` and no `ERESOLVE`, `npm warn peer`, or
`npm warn peerOptional`.

Clean only generated npm artifacts:

```bash
rm -rf packages/sdk/node_modules packages/sdk/package-lock.json
```

- [ ] **Step 5: Run workflow validation**

Run:

```bash
actionlint .github/workflows/pr-checks-sdk-pod.yml
node .github/scripts/lint-workflows.mjs .github/workflows/pr-checks-sdk-pod.yml
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit the workspace npm check**

```bash
git add .github/workflows/pr-checks-sdk-pod.yml
git commit -m "infra: validate SDK dependency trees with npm"
```

### Task 3: Verify, Push, Open the SDK Pod PR, and Wait for CI

**Files:**
- Verify: `docs/superpowers/specs/2026-08-21-sdk-npm-peer-check-design.md`
- Verify: `docs/superpowers/plans/2026-08-21-sdk-npm-peer-check.md`
- Verify: `.github/workflows/pr-checks-sdk-pod.yml`

**Interfaces:**
- Consumes: branch `QVAC-23901-sdk-npm-peer-check`, org remote `origin`, ticket `QVAC-23901`, and the SDK pod PR template.
- Produces: a Ready-for-review same-repository PR targeting `main`, plus successful automatic and manually dispatched SDK Pod Checks.

- [ ] **Step 1: Run final local verification**

Run:

```bash
actionlint .github/workflows/pr-checks-sdk-pod.yml
node .github/scripts/lint-workflows.mjs .github/workflows/pr-checks-sdk-pod.yml
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: validators pass; only the two unrelated untracked skill directories
remain outside the committed branch diff.

- [ ] **Step 2: Inspect the complete branch diff and history**

Run:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: design/plan documentation plus the focused SDK pod workflow changes.

- [ ] **Step 3: Push to the org remote**

```bash
git push -u origin QVAC-23901-sdk-npm-peer-check
```

Expected: the org branch is created and local tracking is configured.

- [ ] **Step 4: Create the PR with `/qv-sdk-pr-create`**

Use:

```text
QVAC-23901 infra: validate SDK dependency trees with npm
```

The body must explain:

- Bun can accept an npm-incompatible peer tree.
- The workspace npm check fails on process errors and peer warnings.
- npm artifacts are removed before all existing Bun checks.
- consumer default/lean failures are aggregated.
- No new job or required status was added.
- Local actionlint/workflow-lint and historical mismatch reproduction results.

Create the same-repository PR against `main` and return its GitHub URL.

- [ ] **Step 5: Exercise the changed workflow definition**

Because a workflow-only PR is a fast no-op in path-based package detection,
dispatch the changed workflow on the pushed branch:

```bash
gh workflow run "PR Checks (SDK Pod)" --repo tetherto/qvac --ref QVAC-23901-sdk-npm-peer-check
```

Find the branch run:

```bash
gh run list --repo tetherto/qvac --workflow "PR Checks (SDK Pod)" --branch QVAC-23901-sdk-npm-peer-check --limit 1 --json databaseId,status,conclusion,url
```

Wait for it to finish and inspect failed logs if needed. Expected:
`SDK Pod Checks` succeeds after running the npm check and the complete existing
Bun pipeline.

- [ ] **Step 6: Wait for all PR checks**

Use the PR CI watcher until every required check reaches a terminal state.
If a check fails, classify it as implementation, workflow, or transient
infrastructure failure; fix implementation/workflow failures, push, and wait
again. Report the final PR URL and CI result.
