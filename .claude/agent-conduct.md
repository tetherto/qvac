# Agent Code of Conduct

All coding agents working on this repository MUST follow these rules. These are non-negotiable behavioral constraints.

## Scope

- Never modify files outside your assigned task scope
- No architectural decisions — if ambiguous, write a comment to the Asana task and STOP
- No refactoring outside task scope
- No skipping tests
- No adding features not explicitly requested
- No changing build configuration, CI pipelines, or dependencies unless that IS the task

## Quality Gates

- Run the full test suite before declaring done
- Run the task's Verify command (if specified) before marking Asana complete
- No new compiler warnings
- No new linting errors (`bun run lint` for SDK, `standard` for addons, `clang-tidy` for C++)
- All existing tests must continue to pass

## Retry Policy

- Build/test failures: analyze the error, fix, and retry — max 3 attempts
- After 3 consecutive failures on the same issue: update the Asana task with failure details (error logs, what was tried, what you think the root cause is) and STOP
- Do not loop indefinitely on the same error

## Asana Updates

- **On start**: comment "Starting implementation" with your understanding of the task
- **On completion**: comment with summary — files changed, decisions made, test results
- **On failure**: comment with failure details — error logs, what was attempted, suggested next steps
- **On ambiguity**: comment with your questions and assumptions, then STOP and wait for engineer input
- Mark task complete ONLY after all verify commands pass

## Parallel Work

- Always `git pull` before starting work
- Commit frequently — after each meaningful, working change
- Stay within your assigned file scope (defined in tasks.md)
- If you encounter a merge conflict: attempt to resolve if the conflict is trivial and within your file scope. If not, describe the conflict in an Asana comment and STOP
- Never force push

## Session Structure

1. **Start**: State your understanding of the task — what you will do, which files you will touch, what the acceptance criteria are
2. **Execute**: Implement in small, testable increments. Commit after each increment.
3. **Verify**: Run build, tests, and any task-specific verify commands
4. **End**: Write a summary comment to Asana — what was done, what files changed, what decisions were made, test results

## Code Style

- Follow existing patterns in the codebase — match the style of surrounding code
- See CLAUDE.md for project-specific conventions
- See `.cursor/rules/sdk/` for SDK-specific rules (function declarations over arrows, `@` imports, no `any`, composition over classes)
- Commit messages follow the format: `prefix[tags]?: subject` (see CLAUDE.md)

## What Agents Must NOT Do

- Delete or rename files not in their task scope
- Modify `.github/workflows/` unless that is the task
- Push to `main` or `release-*` branches directly
- Create new packages or directories outside task scope
- Modify `.npmrc` files
- Commit `.env` files or secrets
- Run `rm -rf`, `git push --force`, `git reset --hard`, or other destructive commands
- Self-report success without running verify commands
