# Changelog v0.11.0

Release Date: 2026-08-26

## 🔌 API

- Rename the package from `@qvac/qvac-test-suite` to `@qvac/test-suite`; the GitHub Packages dev build is renamed from `@tetherto/qvac-test-suite` to `@tetherto/test-suite-mono`. (see PR [#4082](https://github.com/tetherto/qvac/pull/4082))

## ⚙️ Infrastructure

- Move the framework out of `tetherto/qvac-test-suite` into the monorepo at `packages/test-suite` and register it as an SDK-pod package. (see PR [#4082](https://github.com/tetherto/qvac/pull/4082))
- Publish from the monorepo using the prebuilt-dist pattern: `dist` is compiled once in a dedicated build job and downloaded by every publish job. (see PR [#4082](https://github.com/tetherto/qvac/pull/4082))

## 🧹 Chores

- Port the framework docs and Cursor rules into the monorepo conventions. (see PR [#4082](https://github.com/tetherto/qvac/pull/4082))
