# Contributing

## Pull Request Labels

The following labels control CI workflow behavior:

- **`verify`** - Triggers extended integration tests, benchmarks, and model validation
- **`safe-to-test`** - Required for external fork PRs to run CI checks (security gate)
- **`staging`** - Triggers staging environment deployment for model validation
- **`review`** - Triggers approval check workflow
- **`tier1`** - Priority tier 1 issues/PRs
- **`nlp`** - Natural language processing related changes

### Label Usage

- Add `verify` when changes need thorough integration testing before merge
- Team members must add `safe-to-test` to external PRs after code review
- Use `staging` to validate models in staging environment before production
- Comment with `/review` or add `review` label to trigger approval checks
