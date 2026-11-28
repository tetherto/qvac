# QVAC SDK for Swift

The Swift client for the QVAC SDK, for iOS 15 and macOS 13 or newer. It runs
the QVAC worker inside the app and talks to it.

This repository holds the published releases only. Each tag is one QVAC SDK
release. The source, the issues and the full documentation live in
[tetherto/qvac](https://github.com/tetherto/qvac/tree/main/packages/sdk-swift).

## Install

Add the package at an exact version, and the one worker profile product the
app needs next to `QvacSDK` and `QvacBareKit`:

```swift
.package(url: "https://github.com/tetherto/qvac-sdk-swift", exact: "<version>")
```

| Product | Plugins |
| --- | --- |
| `QvacWorkerAll` | every plugin |
| `QvacWorkerAssistant` | completion, Parakeet transcription |
| `QvacWorkerLLM` | completion, embeddings |
| `QvacWorkerSpeech` | Whisper, BCI and Parakeet transcription, translation, text to speech |
| `QvacWorkerVision` | completion, OCR, image classification |
| `QvacWorkerMedia` | audio generation, image generation |
| `QvacWorkerRobotics` | vision-language-action |

```swift
import QvacBareKit
import QvacSDK

let client = try await QvacClient.start(profile: .llm)
```

Each profile and its native addons are prebuilt frameworks, downloaded from the
`sdk-v<version>` release of tetherto/qvac and checked against the checksums in
`Package.swift`.
