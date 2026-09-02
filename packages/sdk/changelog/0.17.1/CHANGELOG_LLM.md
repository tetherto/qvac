# QVAC SDK v0.17.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.17.1

QVAC SDK 0.17.1 is a patch cut focused on Python packaging and release lockstep. It ships self-contained per-platform `tetherto-qvac-sdk` wheels on the GitHub release, keeps thin wheels on PyPI, makes the embedded Python examples runnable without shared helpers, and publishes `@qvac/inference` together with `@qvac/sdk`, `@qvac/bare-sdk`, and `tetherto-qvac-sdk` at the same version. It also fixes Windows fat-wheel builds and a dropped `bare-rpc` stream teardown.

## Features

### Self-Contained Python Wheels on the GitHub Release

`tetherto-qvac-sdk` now builds per-platform "fat" wheels that bundle a platform-matched Bare runtime for turnkey installs from the `sdk-v*` GitHub release assets. PyPI continues to publish thin wheels; use the release asset URL with `pip install … -f` when you want the self-contained path.

## Bug Fixes

### Windows Fat-Wheel Build and bare-rpc Stream Teardown

Fat-wheel builds on Windows failed because `subprocess` launched `npm` without resolving `npm.cmd`. The build script now resolves `npm` via `shutil.which`. Separately, peer STREAM DESTROY frames from `bare-rpc` invoked async `OutgoingStream.destroy` without scheduling it; the Python transport now schedules that coroutine on the RPC task set so the outgoing stream actually closes.

## Docs

### Standalone Python Examples

The embedded Python examples no longer depend on a shared `_common.py` helper. Each example is self-contained so the docs snippets and local runs stay aligned.

## Release Packaging

This cut also folds `@qvac/inference` into the same `publish-sdk.yml` release path as the other lockstep packages, so a `release-sdk-*` push ships inference / sdk / bare-sdk / python together (including `inference-v*` tags) instead of relying on a standalone inference publish workflow.
