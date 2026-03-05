Run the agent setup script to configure agent tooling.

Argument: $ARGUMENTS (one of: claude, cursor, all — defaults to "all" if empty)

Steps:
1. Run `.agent/setup.sh` with the provided argument from the repository root.
2. If $ARGUMENTS is empty, run `.agent/setup.sh all`.
3. Report the output to the user.
