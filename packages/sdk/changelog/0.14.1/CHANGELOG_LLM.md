# QVAC SDK v0.14.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.14.1

QVAC SDK 0.14.1 is a patch release that fixes `qvac bundle sdk` for projects where the SDK is installed as a symlink — the common layout under pnpm and npm/yarn workspaces.

## Bug Fixes

### Bundling Works for Symlinked SDK Installs

Bundling the SDK worker (`qvac bundle sdk`) previously failed with a `bare-pack` error when `@qvac/sdk` was installed as a symlink rather than a plain copy — the layout produced by pnpm and by npm/yarn workspaces. The bundler looked for the SDK's low-level `bare-*` runtime dependencies relative to the symlink's location instead of where the SDK actually lives on disk, so it couldn't find them and aborted.

The bundler now resolves the SDK's worker imports against the SDK's real on-disk path, so its hoisted `bare-*` dependencies are found regardless of how the package was installed. Plain (copied) installs are unaffected; symlinked installs now bundle and verify successfully.
