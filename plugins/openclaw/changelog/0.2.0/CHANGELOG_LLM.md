# QVAC OpenClaw Plugin v0.2.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.2.0

The local QVAC service now runs authenticated. The launcher reads a bearer key from a private owner-only file and hands it to `qvac serve` without ever placing it in a process argument list. Existing installs must re-onboard once.

## Breaking Changes

### Re-onboard to migrate an existing install

The key reaches the launcher as an `--api-key-file` path in `localService.args`, and that argument list is persisted in `openclaw.json` by onboarding. An install configured before this release has a persisted list without it, so upgrading the plugin alone is not enough:

```bash
openclaw onboard --auth-choice qvac
```

Until you run it, starting the local QVAC service fails with `--api-key-file requires a value …`, which names the same remedy. This is deliberate: the launcher will not fall back to an unauthenticated serve, and it will not guess a key-file path that onboarding never wrote. Re-onboarding is idempotent for installs that have already migrated — it reuses the existing key file, refreshes the provider entry, and leaves your model choice alone.

### The key file is validated on every launch

A key file that is not a regular file, or whose permissions let anyone but the owner read it, now stops the launcher instead of being used. The check runs on every read rather than only at onboarding, because the path is long-lived: a file swapped for a symlink or loosened to group-readable between runs would otherwise be picked up silently. Recover with `chmod 600` on the file, or by re-running onboarding.

## Security

### The key stays out of the process list

Neither the launcher nor the `qvac serve` process it starts receives the key in its arguments. The serve is started with `--api-key-file` pointing at the same owner-only file, so the credential cannot be recovered from `ps` or `/proc/<pid>/cmdline`, which on Linux is readable by every local account.

Whether that is possible depends on the CLI in use, so the launcher runs the `@qvac/cli` installed alongside the plugin — the same install it reads the version from — through the current Node executable. A `qvacCommand` set to an explicit path is spawned verbatim instead and its version cannot be determined; that case falls back to `--api-key`, where the key is visible to local process inspection.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.6.0` for the shared model catalog
- `@qvac/cli@^0.11.0` for `qvac serve` (SDK 0.17 runtime), the first CLI that accepts `--api-key-file`
