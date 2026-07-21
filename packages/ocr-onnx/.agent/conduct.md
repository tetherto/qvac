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
- **If you create a test or example, you MUST run it and confirm it passes before declaring done** — never commit untested code
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

## Cross-Platform CI Validation

After local tests pass, validate changes across all platforms using CI:

1. **Push your branch** to the remote
2. **Trigger the CI workflow** manually: `gh workflow run "On PR Trigger (<package>)" --ref <your-branch>`
   - Package names: `LLM`, `OCR`, `TTS`, etc. — match the package you changed
3. **Monitor the run**: `gh run list --workflow "On PR Trigger (<package>)" --branch <your-branch> --limit 1`
4. **Wait for completion**: `gh run watch <run-id>` — this blocks until the workflow finishes and shows live status
5. **Check results**: all platforms must pass (Linux, macOS, Windows, mobile if applicable)
6. **If a stage fails**:
   - Read the logs: `gh run view <run-id> --log-failed`
   - Fix the issue, commit, push, and re-trigger the workflow
   - Repeat until all platforms pass
7. **If the same stage fails more than 5 times** after fixes: document the failure details on the Asana task (error logs, what was tried, platforms affected) and STOP

CI must pass on all platforms before marking the task as complete.

## Bash Command Rules

To avoid triggering permission prompts, keep shell commands simple and pre-approvable:

- **No `$()` command substitution** in shell commands — write to a temp file instead (e.g. use `git commit -F /tmp/msg.txt` instead of `git commit -m "$(cat <<EOF ... EOF)"`). For `$(nproc)`, query `nproc` first then hardcode the value (e.g. `make -j12`)
- **No shell redirects** like `2>/dev/null`, `2>&1`, or pipes (`|`) — these trigger permission prompts that cannot be pre-approved. Just omit them; tool output captures both stdout and stderr already
- **One command per Bash call** — never chain with `&&`, `||`, or `;`. Make multiple separate Bash tool calls instead. Use flags like `git -C <path>` instead of `cd <path> && git ...`
- **Use dedicated tools** when available — use Read instead of `cat`, Grep instead of `grep`, Glob instead of `find`, Edit instead of `sed`
- **Use simple `ls`** to check if files/dirs exist — one path per call if needed

## Tests Are Sacred

- **NEVER delete, disable, or skip existing tests** — no `skip()`, no `todo()`, no commenting out, no removing test files
- **NEVER add flags or options to bypass failing tests** (e.g. `--bail`, `--ignore`, filter patterns that exclude tests)
- **NEVER weaken assertions** to make a test pass (e.g. changing `t.ok(result.length > 80)` to `t.ok(result.length > 0)`)
- If a test fails: **fix the code or the test**, not skip it
- If a fix is not possible: **document on the Asana task** why the test fails, what you tried, and STOP — let the engineer decide
- New code must have tests. Existing tests must keep passing.

## What Agents Must NOT Do

- Delete, skip, or disable existing tests (see above)
- Delete or rename files not in their task scope
- Modify `.github/workflows/` unless that is the task
- Push to `main` or `release-*` branches directly
- Create new packages or directories outside task scope
- Modify `.npmrc` files
- Commit `.env` files or secrets
- Run `rm -rf`, `git push --force`, `git reset --hard`, or other destructive commands
- Self-report success without running verify commands
