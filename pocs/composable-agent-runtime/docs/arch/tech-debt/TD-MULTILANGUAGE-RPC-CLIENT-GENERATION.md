# TD: Multilanguage RPC Client Generation

## Problem

The PoC's Sync and Harness schemas generate JavaScript HRPC bindings and
TypeScript types only. Python, Swift, and Kotlin clients would require
handwritten protocol implementations, which can drift from the worker contract.
`bare-stow` packages and connects the worker but does not generate language
bindings.

## Recommended Solution

Define language-neutral Sync and Harness RPC artifacts and generate typed
TypeScript, Python, Swift, and Kotlin clients from the same contract. Keep
transport and worker packaging platform-specific, but run shared wire fixtures
against every generated client. The published language client must include the
matching worker artifact and hide worker discovery and spawning.

