# Changelog v0.7.1

Release Date: 2026-03-16

## 🐞 Fixes

- Restore registry download throughput by adding bulk block prefetch before streaming. (see PR [#835](https://github.com/tetherto/qvac/pull/835))
- Clear blob blocks from corestore after successful download to reclaim disk space. (see PR [#835](https://github.com/tetherto/qvac/pull/835))
- Fix stream cleanup to trigger automatically when consumer finishes reading. (see PR [#835](https://github.com/tetherto/qvac/pull/835))

## 🧹 Chores

- Bump @qvac/registry-client to ^0.2.1. (see PR [#921](https://github.com/tetherto/qvac/pull/921))
