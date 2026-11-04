# RPC LAN device validation

This fixture runs the public SDK on a physical phone against an independently
advertised Mac server. The app reports results over local HTTP. Discovery and
native RPC use the LAN. Both devices must share a multicast-capable link.

AppState background and foreground events call SDK `suspend()` and `resume()`.
A lifecycle coordinator serializes those transitions and manual lifecycle
commands. It waits for an active runtime before dispatching engine work, while
allowing backgrounding to suspend a lookup already in flight. Repeated events
do not repeat successful transitions. Close rejects waiting work and prevents later
resume or state calls. SDK close owns native-server shutdown.

The app records each transition result and the actual SDK state after suspend
or resume. It also records typed server health, including owned server IDs and
advertisement failures. Android logs the actual multicast-lock state under the
`QvacRpcLan` tag. The native lock and SDK lifecycle have separate records.

## Build and run

Build the current inference, SDK and e2e chain, then check the coordinator races:

```sh
npm run install:build:full
node --test fixtures/rpc-lan-device/*.test.mjs
```

Run these commands from `packages/sdk-e2e`. Start the coordinator with a cached
GGUF file:

```sh
QVAC_RPC_LAN_MODEL_PATH=/path/to/model.gguf \
QVAC_WORKER_PATH="$PWD/qvac/worker.entry.mjs" \
node fixtures/rpc-lan-device/coordinator.mjs
```

Copy its `coordinator` URL from the `READY` line. Prepare a fresh app directory:

```sh
QVAC_RPC_LAN_COORDINATOR='http://<mac-lan-ip>:19764' \
node fixtures/rpc-lan-device/prepare.mjs /tmp/qvac-rpc-lan-validation
cd /tmp/qvac-rpc-lan-validation
npm install --install-links --ignore-scripts
npx tsc --noEmit
npx expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease --max-workers=4
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n io.tether.qvac.rpc.lanvalidation/.MainActivity
adb logcat -v threadtime -s QvacRpcLan ReactNativeJS
```

The generated app has its own TypeScript configuration. The sdk-e2e package's
typecheck excludes this fixture, so run the generated app's typecheck too.
The SDK plugin supplies the worker bundle and native links. Local HTTP is enabled
only in this validation app.

For iOS, set `QVAC_RPC_LAN_IOS_BUNDLE_ID` and `QVAC_IOS_TEAM_ID` when preparing
the app. Use the owning team's development profile with Apple's approved
multicast entitlement, then prebuild and build the iOS project normally. The
fixture does not grant or request that entitlement. Accept the Local Network
prompt on the phone. Capture the app and native runtime output in Xcode.
Simulator results do not establish physical-device support.

Both preparation and the Mac coordinator accept `QVAC_RPC_LAN_ADDRESSES`, a
comma-separated list of local private IPv4 addresses. This opts renamed adapters
into discovery membership and advertiser selection. `QVAC_RPC_LAN_HOST` selects
the serving TCP bind address separately and must belong to that list when both
are supplied. These selections cannot prove an arbitrarily renamed adapter is
physical. The engine still validates local addresses, host addresses and masks.

## Commands and records

The coordinator exposes `GET /info`, `GET /results` and `POST /enqueue`.
Enqueue a command with a JSON body such as:

```json
{ "device": "android", "op": "discover", "lanAddresses": ["10.0.0.2"] }
```

Use an address that belongs to the phone. Omit `lanAddresses` for automatic
selection. Use `device: "ios"` for an iPhone. Available operations are `discover`,
`serve`, `restart`, `stop`, `cancel`, `suspend-resume`, `infer-discovered`,
`infer-explicit-control` and `close`. Serving, discovery, cancellation and
inference through discovery accept `lanAddresses`. Serving and restart accept
`host`. `stop` and `restart` require the returned owned `serverId`. Restart stops
that server before starting a new one. Clients must rediscover its endpoint.

`infer-explicit-control` requires an explicit `servers` inventory. Keep its
results separate from discovery results. `suspend-resume` exercises SDK calls
while foregrounded. Physical background and foreground testing must use OS
AppState changes and the resulting lifecycle records.

Task results include phone model, OS, prepared app commit, whether preparation
saw uncommitted changes, inference and SDK versions, native-addon package
versions, selected endpoints, health and transition records. `/info` includes
Mac build metadata and the provisioned model's filename and size. The prepared
mobile Bare and BareKit versions come from the SDK's runtime mapping. The
desktop runtime package version is separate. Verify the embedded runtime versions
against the installed app's native startup logs. Null version fields mean the
package was unavailable during preparation and must be recorded before a pass.
Keep model hashes with the run evidence when comparing cached-model runs.

The app and coordinator retain at most 64 native-log records, each with a
1024-character message. The app keeps 16 health records and 32 lifecycle records.
Capture the process logs for longer runs. Native log availability depends on the
addon and backend.

## Physical acceptance matrix

Record a result for each applicable iPhone and Android role:

- Discover the coordinator's actual URL and inventory. Run concurrent lookups,
  a different topic and cancellation of one lookup while another completes.
- Serve on the phone and discover it from the Mac through `GET /discover`.
  Repeat with explicit address selection, including a renamed eligible adapter.
- Deny the applicable local-network permission, record the failure, restore
  permission and repeat discovery and inference.
- Background during a lookup, then foreground before suspension finishes and
  after suspension completes. Require actual SDK `suspended` and `active`
  transition records. On Android, correlate multicast-lock release and acquire
  records with those transitions.
- Remove or change the original serving address. Require failed advertisement
  health with the original owned server ID, a responsive runtime, successful
  stop, then an explicit restart. Confirm that the old endpoint no longer
  advertises and that clients discover the new endpoint.
- Stop or close the server. Verify advertisement expiry and an unreachable native
  endpoint. Close while transitions are pending and confirm there is no later
  resume or newly started worker.
- Execute `infer-discovered` on the phone using Mac RPC devices. Execute
  `POST /infer` with `{"remoteOnly":true}` on the Mac using the phone's RPC devices
  where the backend supports that role. Preserve the selected URLs and aliases.
- Repeat discovery and inference without WAN access using an already provisioned
  model. Keep the LAN coordinator available. `QVAC_RPC_LAN_MODEL_SRC` at app
  preparation, or a task's `modelSrc`, can select the worker's provisioned model
  path or source. The default model URL is the LAN coordinator's cached file.

Inference tasks require text containing `hello` with a fixed seed and temperature
zero. Their `executionEvidence.status` remains `pending-external-verification`.
An `ok` command result, inventory, allocation log or completion text alone does
not prove remote tensor execution. A physical pass also requires native server
graph or tensor-work evidence tied to the selected endpoint and run timestamps.
Attach that evidence to the run record. Keep explicit-endpoint controls separate.

Keep `autoClose: false` when unloading models in a worker that owns test servers.
End the run with `close` on each phone and Ctrl-C on the coordinator. Stop the
coordinator after validation.

## Validation status

On 4 November 2026, all 11 fixture lifecycle and diagnostics tests passed. The
generated app passed its strict TypeScript check, Android Expo prebuild, and
static Metro/Hermes exports for Android and iOS. SDK e2e RPC consumers passed
13/13 on desktop and 13/13 in packaged Electron. Python passed 10 cases and
intentionally skipped the three JavaScript-only device-map helper cases.

The separate [native LAN integration test](../../../inference/test/rpc-lan.integration.ts)
reported 14/15 passing checks, with an intermittent child-process discovery
failure. That integration result remains a validation limitation.

On 4 November 2026, device inventory found no attached Android phone. The paired
physical iPhone 15 Pro Max and iPhone 17 Pro were unavailable. The physical matrix,
permission recovery, native remote-execution proof and no-WAN run remain pending.
No physical-device pass is claimed.
