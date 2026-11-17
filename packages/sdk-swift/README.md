# QVAC SDK for Swift

A Swift client for the QVAC worker, for iOS and macOS on Apple silicon at the
versions the worker supports (see the SDK's
[system requirements](https://docs.qvac.tether.io/sdk/system-requirements)). The worker runs
inside the app as a Bare Kit worklet, and the client talks to it with the same
JSON contract as the JavaScript, Python and Kotlin clients.

The package has the client library, `QvacSDK`, and `QvacBareKit`, which starts
a worker inside the app and connects to it. The client's request, response and error types,
one method per worker call, the model list and the error kinds are generated
from `packages/sdk/contract`. Each SDK release publishes the package to
[tetherto/qvac-sdk-swift](https://github.com/tetherto/qvac-sdk-swift), so apps
add that repository's URL.

## Use a published worker profile

Each SDK release publishes ready-made workers, one product per set of plugins,
under the SDK's plain version tag:

| Product | Plugins |
| --- | --- |
| `QvacWorkerAll` | every plugin |
| `QvacWorkerAssistant` | completion, Parakeet transcription |
| `QvacWorkerLLM` | completion, embeddings |
| `QvacWorkerSpeech` | Whisper, BCI and Parakeet transcription, translation, text to speech |
| `QvacWorkerVision` | completion, OCR, image classification |
| `QvacWorkerMedia` | audio generation, image generation |
| `QvacWorkerRobotics` | vision-language-action |

Add the repository with that version and the one product the app needs:

```swift
.package(url: "https://github.com/tetherto/qvac-sdk-swift", exact: "<version>")
```

```swift
import QvacBareKit
import QvacSDK

let client = try await QvacClient.start(profile: .llm)
```

The product brings the worker and its native addons as prebuilt frameworks
from the release, and `start(profile:)` throws `QvacWorkerError` with code
`WORKER_PROFILE_MISSING` when the app does not link that profile.

The worker keeps models and caches in its home directory. By default that is
`Application Support/qvac` on iOS, and on macOS `QVAC_HOME_DIR` when set, else
the user's home directory. Pass `homeDirectory:` to `start` or `connect` to
choose another.

## Add the worker to an app

For a custom set of plugins, the worker is bundled per app, with the plugins its `qvac.config.json` lists.
`bundleSdk` from `@qvac/sdk/commands` writes it as a Swift package, together
with Bare Kit and the native addons for each host:

```js
import { bundleSdk } from '@qvac/sdk/commands'

await bundleSdk({
  projectRoot,
  target: 'bare-kit',
  language: 'swift',
  outputDir: 'ios/QvacWorker'
})
```

The hosts default to iOS (device and simulator). For a macOS app, pass the
`darwin-*` hosts instead; one bundle cannot hold both, as addons split into
per-platform packages resolve for every host in it. Bundling for iOS needs macOS
and the iOS platform packages of the addons, which `installMissingPrebuilds:
true` adds.

The module of the written package is named after its folder, `QvacWorker`
above. Add it and this package to the app as Swift package dependencies.

## Connect

```swift
import QvacSDK
import QvacWorker

let worker = try await QvacWorker.start()
let client = try await QvacClient.connect(ipc: worker.ipc, worklet: worker.worklet)

let reply = try await client.heartbeat()

await client.close()
```

`connect` sends the worker its home directory, the configuration, and the
platform, brand and hardware model of the device. The client keeps the worklet
alive, and `close()` shuts the worker down.

## Models and completions

```swift
for try await event in client.models.loadWithProgress(Models.QWEN3_600M_INST_Q4) {
    if case .result(let loaded) = event { modelId = loaded.modelId ?? "" }
}

let run = try client.completion.run(
    modelId: modelId,
    history: [.system("Be brief."), .user("Name three colors.")]
)
for try await token in run.tokens { print(token, terminator: "") }
let final = try await run.final
```

A run also streams all `events`, and `cancel()` stops it; its `final` then
throws `QvacCompletionCancelledError` with what was generated. Options cover
generation parameters, the KV cache, thinking capture and a JSON response format.

Tools need the model loaded with `"tools": true` in its config:

```swift
let weather = QvacTool(
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: ["city": QvacToolParameter(.string)],
    required: ["city"]
) { arguments in .object(["condition": .string("sunny")]) }

let modelId = try await client.models.load(model, modelConfig: ["tools": .bool(true)]).modelId!
let reply = try client.completion.orchestrate(modelId: modelId, history: history, tools: [weather])
```

`run(..., tools:)` returns the model's tool calls for the app to `invoke()`;
`orchestrate` has the worker call each tool's handler and continue until it
answers.

The other groups are `client.embeddings`, `client.translation`, `client.speech`,
`client.vision`, `client.bci`, `client.media`, `client.system` and `client.raw`.

## Calls

Each worker call is also a method on `QvacClient`, named as in the contract,
taking and returning the generated types:

- A single reply is `async throws` and returns the response type.
- A stream returns `AsyncThrowingStream` of responses. Stopping iteration closes
  the stream on the worker.
- A two-way call, such as `transcribeStream`, also takes the input as
  `AsyncStream<Data>`.
- `loadModel`, `downloadAsset`, `finetune` and `rag` also have a
  `...WithProgress` variant that yields `QvacProgressEvent.progress` and then
  `.result`.

```swift
for try await response in client.completionStream(request) {
    for event in response.events {
        if case .contentDelta(let delta) = event { print(delta.text, terminator: "") }
    }
}
```

Requests whose JSON is a union, such as `LoadModelRequest`, are Swift enums with
one case per variant. They also decode from their JSON.

## Errors

- `QvacError` is an error the worker reported for a request. `kind` is the
  matching `QvacErrorKind` from the contract, when there is one.
- `QvacWorkerError` means the worker could not start, rejected its
  configuration, or went away: it exited, crashed or was closed. `code` names
  the reason, such as `WORKER_PROFILE_MISSING` or `WORKER_CLOSED`.
- `QvacWorkerProtocolError` means the worker sent something outside the
  contract, such as a reply over `maxFrameBytes`. Such a reply fails only its own
  call.
- `QvacRemoteError` is any other bare-rpc error the worker answered a request
  with.
- `QvacConfigurationError` means a client setting is out of range, such as a
  `maxFrameBytes` outside `QvacClient.frameBytesRange`.
- `QvacCompletionError` and `QvacFeatureError` are failures the friendly API
  reports, such as invalid options or a generation that ended in an error.

An uncaught error inside the worker ends only the worker. A crash in
native code, or the system ending the app for memory, ends the app with it.

## iOS example

`ios-example/` is a SwiftUI app that loads `QWEN3_600M_INST_Q4` and streams one
answer. Bundle its worker from this checkout, then open
`ios-example/QvacExample.xcodeproj` in Xcode and run it on a simulator:

```console
node scripts/prepare-worker.mjs ios-example ios-arm64 ios-arm64-simulator
```

The iOS hosts need the iOS platform packages of the addons installed in
`packages/sdk`; the script names any that are missing and their versions. To
run on a device, set a development team in the target's signing settings.

## Development

The client in `Sources/QvacSDK/Generated` is generated from the contract this
checkout's SDK exports and is never committed. Generate it before building, and
again after a change to the SDK, from `packages/sdk-swift`:

```console
python3 scripts/generate.py
```

It runs `npm run contract:export` in `packages/sdk`, so it needs the SDK
installed. The release workflow generates it the same way before it publishes
the package.

Run the unit tests with `swift test` from `packages/sdk-swift`.

The smoke app in `Smoke/` starts a real worker on macOS with the default home
directory, makes request-reply calls and one two-way stream, and shuts the
worker down. It needs `packages/sdk` built. From `packages/sdk-swift`:

```console
node scripts/prepare-worker.mjs Smoke
swift run --package-path Smoke Smoke
```

CI runs the catalog through this client on macOS and iOS with the other
languages' e2e (see `packages/sdk-e2e/runners/swift/README.md`).
