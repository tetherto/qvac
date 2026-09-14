# 💥 Breaking Changes v0.3.0

## Requires the @qvac/cli 0.13 line

`@qvac/cli` 0.13 mounts the serve surfaces as extensions and deprecates the `qvac serve openai` subcommand. The launcher moves to the flag form, and the dependency floors move with it.

**BEFORE:**

```bash
qvac serve openai --config <path> --host 127.0.0.1 --port 11434 --model <id> --api-key-file <path>
```

**AFTER:**

```bash
qvac serve --openai --no-default --config <path> --host 127.0.0.1 --port 11434 --model <id> --api-key-file <path>
```

- Installs that pin `@qvac/cli` to `0.12.x` must move to `0.13.x` alongside the plugin, since a 0.x caret range does not cross a minor.
- `@qvac/ai-sdk-provider` moves to `^0.7.0` in the same step. Provider 0.7 narrows its own optional `@qvac/cli` peer to `^0.13.0`, so a plugin still asking for `@qvac/cli@^0.12.0` next to it would leave the install unresolvable.
- `--no-default` is part of the pair rather than an extra flag: bare `--openai` also mounts the QVAC surface on the port, while the retired subcommand exposed `/v1/*` alone. Keeping both preserves the previous behaviour on a port the plugin authenticates and owns.

No re-onboarding is needed. The serve command is built by the launcher at start time; the argument list onboarding persists in `openclaw.json` holds only the plugin's own options (`--api-key-file`, `--model`, `--host`, `--port`, …) and is unaffected.

---
