# Changelog v0.17.1

Release Date: 2026-08-13

## ✨ Features

- Self-contained per-platform `tetherto-qvac-sdk` wheels via GitHub release assets (thin wheels remain on PyPI). (see PR [#3754](https://github.com/tetherto/qvac/pull/3754))

## 🐞 Bug Fixes

- Fix Windows fat-wheel builds (`npm` → `npm.cmd` via `shutil.which`) and schedule `bare-rpc` `OutgoingStream.destroy` so peer STREAM DESTROY closes the stream. (see PR [#3832](https://github.com/tetherto/qvac/pull/3832))

## 📘 Docs

- Make embedded Python examples standalone. (see PR [#3724](https://github.com/tetherto/qvac/pull/3724))

## 🧹 Chores

- Publish `@qvac/inference` in lockstep with `@qvac/sdk` / `@qvac/bare-sdk` / `tetherto-qvac-sdk` from `publish-sdk.yml` (including `inference-v*` tags). (see PRs [#3796](https://github.com/tetherto/qvac/pull/3796), [#3826](https://github.com/tetherto/qvac/pull/3826))
- Align `packages/inference` on the sdk release line with published `@qvac/inference@0.17.0` before the lockstep `0.17.1` cut.
