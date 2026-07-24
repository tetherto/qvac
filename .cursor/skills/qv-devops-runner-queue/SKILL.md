---
name: qv-devops-runner-queue
description: Inspect GitHub Actions self-hosted runner queues when a developer provides a run URL, job URL, runner label, or reports a blocked CI job, or invokes /qv-devops-runner-queue.
disable-model-invocation: true
---

# GitHub Actions Runner Queue

Run the read-only helper once and present its Markdown output directly without
reformatting or a code fence:

```bash
node .cursor/skills/qv-devops-runner-queue/scripts/inspect-runner-queue.mjs \
  "<job-url|run-url|runner-label>" \
  --repo "owner/repo"
```

For labels, `--repo` defaults to `tetherto/qvac`; URLs supply their repository.
Add `--json` only when requested. Prefer a job URL for its complete scheduling
labels. A run URL must contain exactly one active self-hosted job; otherwise
show the helper's candidates and ask for a job URL.

If `gh` is missing or unauthenticated, report the helper error; never start
authentication. Do not repeat a query unless the user requests a refresh.

The helper only makes GitHub `GET` requests. Never cancel, rerun, change runner
state, or mutate a repository. Cancellation affects the whole run and requires
a separate inspection and confirmation.

Interpretation:

- job URLs match the complete label set; label input matches exact membership;
- running order is oldest-started; queued order is an estimate from `created_at`;
- durations may include dependencies, gates, or concurrency delays;
- PR and branch links use the source repository, including forks;
- results are repository-scoped; no authoritative FIFO position or ETA exists;
- Markdown shows ten jobs per section; `--json` keeps all collected jobs.
