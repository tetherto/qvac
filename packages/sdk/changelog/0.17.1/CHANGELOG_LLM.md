# QVAC SDK v0.17.1 Release Notes

📦 **NPM:** [https://www.npmjs.com/package/@qvac/sdk/v/0.17.1](https://www.npmjs.com/package/@qvac/sdk/v/0.17.1)

QVAC SDK 0.17.1 is a patch cut focused on Python packaging and release lockstep. It ships self-contained per-platform `tetherto-qvac-sdk` wheels on the GitHub release, keeps thin wheels on PyPI, makes the embedded Python examples runnable without shared helpers, and publishes `@qvac/inference` together with `@qvac/sdk`, `@qvac/bare-sdk`, and `tetherto-qvac-sdk` at the same version.

## Features

### Self-Contained Python Wheels on the GitHub Release

`tetherto-qvac-sdk` now builds per-platform “fat” wheels that bundle a platform-matched Bare runtime for turnkey installs from the `sdk-v*` GitHub release assets. PyPI continues to publish thin wheels; use the release asset URL with `pip install … -f` when you want the self-contained path.

## Docs



### Standalone Python Examples

The embedded Python examples no longer depend on a shared `_common.py` helper. Each example is self-contained so the docs snippets and local runs stay aligned.

## Release Packaging

This cut also folds `@qvac/inference` into the same `publish-sdk.yml` release path as the other lockstep packages, so a `release-sdk-*` push ships inference / sdk / bare-sdk / python together (including `inference-v*` tags).