---
name: ci-validate
description: Trigger a CI workflow for a package, wait for completion, and report results
argument-hint: "<package-short-name>"
disable-model-invocation: true
---

# CI Validate — Cross-Platform Workflow Runner

Trigger a CI workflow for a package, wait for it to complete, and report results.

## Argument

The argument `$ARGUMENTS` is the package short name. Valid values:
- `LLM` — qvac-lib-infer-llamacpp-llm
- `Embed` — qvac-lib-infer-llamacpp-embed
- `OCR` — ocr-onnx
- `TTS` — qvac-lib-infer-onnx-tts
- `Whispercpp` — qvac-lib-infer-whispercpp
- `Parakeet` — qvac-lib-infer-parakeet
- `NMTCPP` — qvac-lib-infer-nmtcpp
- `Decoder-audio` — qvac-lib-decoder-audio

The workflow name is: `On PR Trigger (<package>)` where `<package>` is the argument.

## Steps

### Step 1: Validate and push

1. Confirm `$ARGUMENTS` matches one of the valid package names above. If not, show the list and stop.
2. Make sure all changes are committed. If there are uncommitted changes, warn and stop.
3. Push the current branch to origin: `git push origin HEAD`

### Step 2: Trigger the workflow

Run: `gh workflow run "On PR Trigger ($ARGUMENTS)" --repo tetherto/qvac --ref $(git branch --show-current)`

If the trigger fails, show the error and stop.

Wait 5 seconds for the run to register, then find the run ID:
`gh run list --repo tetherto/qvac --workflow "On PR Trigger ($ARGUMENTS)" --branch $(git branch --show-current) --limit 1 --json databaseId,status,conclusion,createdAt`

### Step 3: Monitor the run

Wait for the run to complete: `gh run watch <run-id> --repo tetherto/qvac`

### Step 4: Report results

After the run completes, get the result:
`gh run view <run-id> --repo tetherto/qvac`

- **If all jobs passed**: Report success with a summary of platforms/jobs that passed.
- **If any job failed**:
  1. Get failed logs: `gh run view <run-id> --repo tetherto/qvac --log-failed`
  2. Show the user which jobs/platforms failed and the relevant error logs
  3. Ask if they want you to investigate and fix the issue

For failure analysis, platform details, and troubleshooting: see `.agent/knowledge/ci-validation.md`.

**Important:** Only attempt to fix **infra/CI failures** (environment, config, workflow issues). If the failure is a **code logic error** (compilation error, test assertion, lint violation, type error), report the failure back to the user with the relevant logs — do not attempt to fix application code.

### Step 5: Retry loop (if called by an agent, not interactively)

If running as part of an automated pipeline (not interactive):
1. Analyze the failure logs using the classification guide in `.agent/knowledge/ci-validation.md`
2. If **infra failure**: fix the CI/config issue, commit and push, re-trigger (go to Step 2)
3. If **code logic failure**: stop and report back with the error logs, affected platforms, and which source files need attention
4. If the **same infra failure persists more than 5 times** after fixes: document on the Asana task with full error logs, what was tried, and which platforms are affected — then STOP
