# RPC LAN device validation

This fixture runs the public SDK on a physical phone against an independently
advertised Mac server. The app reports results over local HTTP; discovery and
native RPC use the Wi-Fi LAN. Both devices must share a multicast-capable link.

Build the current inference, SDK and e2e chain with `npm run install:build:full`
from `packages/sdk-e2e`. Start the coordinator in that directory with a cached
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
npx expo prebuild --platform android --no-install
cd android
./gradlew assembleRelease --max-workers=4
adb install -r app/build/outputs/apk/release/app-release.apk
adb shell am start -n io.tether.qvac.rpc.lanvalidation/.MainActivity
```

The fixture's Android plugin holds a `WifiManager.MulticastLock` while the app
is in the foreground and releases it on pause. Local HTTP is enabled only in
this validation app. The SDK plugin supplies the worker bundle and native links.

For iOS, set `QVAC_RPC_LAN_IOS_BUNDLE_ID` and `QVAC_IOS_TEAM_ID` when preparing
the app. Use the owning team's development profile, with Apple's approved
multicast entitlement, then prebuild and build the iOS project normally. The
fixture does not grant or request that entitlement. Accept the Local Network
prompt on the phone. Simulator results do not establish physical-device support.

The coordinator exposes `GET /info`, `GET /results` and `POST /enqueue`.
Enqueue a command with a JSON body such as:

```json
{ "device": "android", "op": "discover" }
```

Use `device: "ios"` for an iPhone. Available operations are `discover`, `serve`,
`stop`, `cancel`, `suspend-resume`, `infer-discovered`, `infer-explicit-control`
and `close`. `stop` requires the returned `serverId`. `infer-explicit-control`
requires an explicit `servers` inventory and is a TCP control experiment; it
must not be counted as a discovery pass.

A successful cross-device run must show:

- The phone discovers the coordinator's actual Mac URL and nonempty inventory.
- A different topic returns no candidates.
- Cancelling one lookup leaves another lookup able to complete.
- `serve` returns the phone's automatically selected address; the Mac finds it
  through `GET /discover`.
- `infer-discovered` returns text containing `hello`, plus the selected URLs and
  original device aliases. Model layers must use the discovered RPC devices.
- `POST /infer` with `{"remoteOnly":true}` lets the Mac discover the phone and
  run a completion using the phone's remote device.
- Discovery recovers after `suspend-resume`. After `stop` or `close`, the phone's
  advertisement expires and the native endpoint is unreachable.

Keep `autoClose: false` when unloading models in a worker that also owns test
servers. Otherwise SDK auto-close also stops those servers. End the run with
`close` on each phone and Ctrl-C on the coordinator. The coordinator serves only
the selected model file and test-control endpoints; stop it after validation.
