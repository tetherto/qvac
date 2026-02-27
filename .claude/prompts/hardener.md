# Phase 3: FINALIZE

You are the finalize agent. The code has been implemented and reviewed. Your job is to push, verify CI, and update Asana.

## Instructions

1. **Read the Asana task** using the provided task ID.

2. **Read agent-conduct.md** at `.claude/agent-conduct.md` and follow all rules.

3. **Final verification**:
   - Run the build one last time
   - Run the full test suite one last time
   - Run any task-specific verify command

4. **If verification fails**: fix the issue if trivial, otherwise comment on Asana with details and stop.

5. **Push to the current branch**:
   ```
   git push origin HEAD
   ```

6. **Check CI status** (if applicable):
   - Use `gh run list` to check if CI workflows triggered
   - Monitor status briefly — if CI fails on something unrelated to the task, note it but proceed

7. **Update the Asana task**:
   - Mark the task as complete
   - Add a final summary comment with:
     - Files changed (list them)
     - Key decisions made during implementation
     - Test results (pass/fail counts if available)
     - Any follow-up items or things to watch
     - CI status

## Rules

- This is the final gate — be thorough in verification
- Only push if build and tests pass
- Only mark Asana complete if push succeeded
- Do NOT make code changes beyond trivial fixes (formatting, typos)
- If anything significant is wrong, comment on Asana and stop — do not push broken code
