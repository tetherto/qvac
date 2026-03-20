# Pear Framework Modules

Pear is the P2P application runtime, development, and deployment platform built on Bare. Application and integration libraries are supplied via installable modules prefixed with `pear-`.

Docs: https://docs.pears.com | Repos: https://github.com/holepunchto

## Application Libraries

| Module | Description |
|--------|-------------|
| pear-crasher | Uncaught exceptions and uncaught rejections crash logger |
| pear-message | Send inter-app pattern-matched object messages |
| pear-messages | Receive object messages that match a given object pattern |
| pear-pipe | Parent-app-connected pipe; other end of pear-run pipe |
| pear-run | Run Pear child app by link. Returns pipe to child |
| pear-updates | Receive platform and application update notifications |
| pear-user-dirs | Get path of user-specific directories |
| pear-wakeups | Receive wakeup events, including link clicks external to app |

## User Interface Libraries

| Module | Description |
|--------|-------------|
| pear-electron | Pear UI library for Electron. Complex API: 100+ methods for window management, media access, power management, tray icons, desktop sources. Fetch README for full API. |
| pear-bridge | Local HTTP bridge for pear-electron applications |

## Common Libraries

| Module | Description |
|--------|-------------|
| pear-drop | Drop data, including application reset |
| pear-dump | Synchronize files from link to dir peer-to-peer or from-disk |
| pear-gracedown | Pear graceful closer; use with pipe.autoexit = false |
| pear-info | Read Pear project information by link |
| pear-link | Parser-serializer for pear:// links; alias resolution |
| pear-opwait | Pear operation stream promise wrapper |
| pear-release | Set application production release version length |
| pear-seed | Seed or reseed a Pear app drive by link |
| pear-stage | Synchronize from-disk to app drive peer-to-peer |
| pear-stamp | Interleave locals into template, sync and stream |

## Developer Libraries

| Module | Description |
|--------|-------------|
| pear-inspect | Securely enable remote debugging protocol over Hyperswarm |
| pear-hotmods | For pear-electron UI apps; framework-agnostic live-reload |

## Integration Libraries

| Module | Description |
|--------|-------------|
| pear-appdrive | Read-only Hyperdrive API subset for application drives |
| pear-aliases | List of aliases for pear:// links |
| pear-api | global.Pear API class |
| pear-changelog | Changelog parsing and diffing |
| pear-constants | Shared Pear constants |
| pear-cmd | Command parser and definitions |
| pear-errors | Shared Pear error types |
| pear-ipc | Interprocess Communication |
| pear-ref | IO handle reference counter and tracker |
| pear-rti | Runtime Information state bootstrap |
| pear-state | Shared state structure and capabilities |
| pear-terminal | Terminal UI library |
| pear-tryboot | Tries to boot sidecar on connect failure (with pear-ipc) |

## App Lifecycle

- `pear init` - Create new Pear project
- `pear run` - Run app by link
- `pear stage` - Sync from-disk to app drive
- `pear seed` - Seed/reseed app drive
- `pear release` - Set production release version

## pear-electron

Most complex Pear module. Covers window/view management, media access, power management, tray icons, desktop sources, and many Electron-like controls. When working with Pear desktop apps, fetch the README and API docs from the repo; the surface is large.
