# QVAC SDK v0.13.5 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.13.5

A patch release that fixes Expo RPC worker cleanup on Android and other
non-iOS platforms when the SDK closes its RPC connection.

## Bug Fixes

### Clean up the Expo RPC worker on non-iOS close

On Expo, closing the SDK RPC connection now sends the worker a shutdown
roundtrip before dropping client-side references. On iOS the worklet can still
be terminated safely; on Android and other non-iOS platforms the worklet cannot
be terminated without risking a native crash, so the SDK releases addon logger
handles and clears worklet state instead.

After shutdown, the SDK also resets its worklet reference so the next RPC
session starts with a fresh worker and a fully populated plugin registry. This
prevents follow-up model loads from failing with "Plugin not found" when tests
or app flows unload the last model and auto-close the RPC client between runs.

The same update is mirrored into the Bare build (`@qvac/bare-sdk`), which ships
in lockstep with `@qvac/sdk`.
