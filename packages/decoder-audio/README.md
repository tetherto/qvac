# decoder-audio

This decoder library leverages FFmpeg for efficient audio decoding. It simplifies processing of input audio, particularly as a preprocessing step for other addons.

It also provides video-frame extraction for VLM inputs. The audio API is unchanged;
the package is still named `@qvac/decoder-audio`.

## Video frames

```javascript
const { VideoFrameDecoder } = require('@qvac/decoder-audio/video')
const decoder = new VideoFrameDecoder()

for await (const { rgb, width, height, ptsMs } of decoder.frames('/videos/clip.mp4')) {
  // rgb is an owned Uint8Array: width * height * 3 bytes, packed RGB24.
  // Pass selected frames and their timestamps to a video-capable VLM.
}
console.log(decoder.runtimeStats)
```

This API runs in Bare, including a Bare worker inside a mobile app. It does not
load model weights, require `load()`, launch an FFmpeg executable, or itself run
a VLM. It reuses [bare-ffmpeg](https://github.com/holepunchto/bare-ffmpeg)'s CPU
decoders and scaler. Adding this package to an app that does not already use it
still adds bare-ffmpeg's native binaries.

`frames(input, { signal })` accepts a local file path, a complete `Uint8Array`, a
synchronous `{ size, read(offset, length): Uint8Array }` reader, or an
`AsyncIterable<Uint8Array>`. The reader must provide bytes synchronously and may
return short reads. Inputs must remain unchanged while in use. Network URLs are
not fetched by this API; an app can provide downloaded chunks instead.

Finite chunk streams are saved to a private, size-limited temporary file before
decoding. This supports MP4 files whose index is at the end; it is **not live
streaming**. Staged files are deleted after completion, failure, early iterator
exit, or cancellation. A process crash can leave a temporary directory; apps
with stricter storage policies should supply an app-managed `tempDirectory` and
clean stale directories on startup. The source producer must cooperate with
cancellation to stop its own network or I/O work.

`probe(input, { signal })` returns dimensions, duration, codec, rotation, an HDR
flag and the chosen sampling policy without decoding all frames. In `auto` mode
it scans video packet metadata; this reads the file but does not decode pixels.
A chunk iterable is consumed by `probe`; use a fresh input for a later `frames`
call. Avoid a separate probe if only extraction is needed: `runtimeStats.info`
already contains this information.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | Use key frames when their rate is 1–5/s, with no gap longer than 1s and no burst above 5/s. Otherwise sample uniformly. `uniform` and `keyframes` are explicit overrides. |
| `fps` | 2 | Maximum target sampling rate; not a promise that every requested timestamp has a frame. |
| `maxFrames` | 64 | Maximum sampled frames, spread across the complete clip. |
| `maxDurationS` | 300 | Reject longer clips; no silent truncation. |
| `maxDimension` | 448 | Longest output edge, preserving aspect ratio and never upscaling. |
| `maxInputBytes` | 2 GiB | Limit for files, byte arrays, readers and staged chunks. |
| `maxOutputBytes` | 64 MiB | Total emitted RGB byte budget. |
| `tempDirectory` | OS temporary directory | Parent for private per-request staging directories. |

Policy defaults and hard safety ceilings live in `src/video/config.ts` and are
exported as `VIDEO_DEFAULTS`/`VIDEO_LIMITS`. Options may lower the budgets; output
resolution can be increased up to the hard ceiling if the byte budget allows it.
For uniform sampling the interval is `max(1000 / fps, durationMs / maxFrames)`.
A 10-second clip therefore uses up to 2 fps; a 5-minute clip uses about one frame
every 4.69 seconds. Codec key frames are compression boundaries, not selected
important events. Auto/key-frame modes can miss brief actions; use `uniform`
when predictable temporal coverage matters. Returned timestamps are the actual
decoded presentation times relative to the first video presentation.

Memory is bounded, not constant throughout a VLM pipeline. The iterator releases
its native decoder/scaler resources, but any frames the caller retains still
occupy RAM. 64 square 448-pixel RGB frames require 36.75 MiB for one copy; decoder
buffers, native copies, model image preprocessing, weights and KV cache are
additional. Model context checks remain necessary even when frame limits pass.

Limitations: finite duration must be available; source images are limited to
4096×2160 pixels in area; non-square pixels, mirrored/perspective transforms and
mid-stream format/dimension changes are rejected. Audio tracks are ignored.
HEVC/HDR decoding depends on the bundled codec, and conversion to RGB24 is not
HDR tone mapping: HDR colors may differ from display playback. DRM-protected
content and arbitrary live sessions are not supported.

See `example/extract-video.js` for an executable path/chunk example. Generated
fixtures in `test/helpers/video-fixture.js` exercise decoding, EOF drain,
rotation, sampling, mixed audio/video and cleanup without internet downloads.

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)  
- [Usage](#usage)  
  - [1. Creating the Decoder Instance](#1-creating-the-decoder-instance)  
  - [2. Loading the Decoder](#2-loading-the-decoder)  
  - [3. Decoding Audio](#3-decoding-audio)  
  - [4. Handling Response Updates](#4-handling-response-updates)  
  - [5. Unloading the Decoder](#5-unloading-the-decoder)
- [Quickstart Example](#quickstart-example)  
- [Testing](#testing)  
  - [Running Unit Tests](#running-unit-tests)  
  - [Test Coverage](#test-coverage)  
- [Glossary](#glossary)  
- [Resources](#resources)  
- [License](#license)  

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | N/A (CPU only) |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | N/A (CPU only) |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | N/A (CPU only) |
| Android | arm64 | 12+ | ✅ Tier 1 | N/A (CPU only) |
| Windows | x64 | 10+ | ✅ Tier 1 | N/A (CPU only) |

**Dependencies:**
- inference-addon-cpp: C++ addon framework
- FFmpeg: Audio decoding engine
- Bare Runtime (latest): JavaScript runtime

## Installation

### Prerequisites

Ensure that the [`Bare`](#glossary) Runtime is installed globally on your system. If it's not already installed, you can add it using:

```bash
npm install -g bare@latest
```

### Installing the Package

Install the latest version of the decoder addon with the following command:

```bash
npm install @qvac/decoder-audio@latest
```

## Usage

This library provides a simple workflow for decoding audio streams.

### 1. Creating the Decoder Instance

To get started, import the decoder and create an instance:

```javascript
const { FFmpegDecoder } = require('@qvac/decoder-audio')

const decoder = new FFmpegDecoder({
  config: {
    audioFormat: 's16le', // 's16le' | 'f32le'; default is 's16le'
    sampleRate: 16000 // in Hz; default is 16000
  }
})
```

The `config` object accepts the following parameters:

* **`audioFormat`**: Specifies the output format of the decoded audio. Supported values:

  * `'s16le'`: Signed 16-bit little-endian PCM — a widely used raw format.
  * `'f32le'`: 32-bit floating-point little-endian PCM — ideal for high-precision audio processing.

  Default: `'s16le'`.

* **`sampleRate`**: Sample rate of the output audio in Hertz (Hz).
  Default: `16000` (16 kHz), commonly used for speech processing.

### 2. Loading the Decoder

Initializes and activates the decoder with the provided or default configuration. This method must be called before decoding any audio input.

```javascript
try {
  await decoder.load()
} catch (err) {
  console.error('Failed to load decoder:', err)
}
```

### 3. Decoding Audio

In order to decode audio, we must create an audio stream and pass it to the `run()` method. This method returns a [`QVACResponse`](#glossary) object.

```javascript
const fs = require('bare-fs')
const audioFilePath = './sample.ogg'
const audioStream = fs.createReadStream(audioFilePath)

const response = await decoder.run(audioStream)
```

### 4. Handling Response Updates

The response supports real-time updates via `.onUpdate()`. Each update delivers a chunk of decoded audio data, which can be processed or saved as needed:

```javascript
await response
  .onUpdate(output => {
    // `output.outputArray` is a Uint8Array
    console.log('Decoded chunk:', new Uint8Array(output.outputArray))
  })
  .await() // wait for the stream to finish
```

You can append or otherwise process these frames as needed.

### 5. Unloading the decoder

Always unload the decoder when done to free memory:

```javascript
try {
  await decoder.unload()
} catch (err) {
  console.error('Failed to unload decoder:', err)
}
```

## Quickstart Example

The following example demonstrates how to use the decoder to decode a sample OGG file into a raw audio file. Follow these steps, to run the example:

### 1. Create a new project:
   
```bash
mkdir decoder-example
cd decoder-example
npm init -y
```

### 2. Install the required dependencies:
   
```bash
npm install bare-fs @qvac/decoder-audio
```

### 3. Create a file named `example.js` and paste the following code:

```javascript
'use strict'

const fs = require('bare-fs')
const { FFmpegDecoder } = require('@qvac/decoder-audio')

const audioFilePath = './path/to/audio/file.ogg'
const outputFilePath = './path/to/output/file.raw'

async function main () {
  const decoder = new FFmpegDecoder({
    config: {
      audioFormat: 's16le',
      sampleRate: 16000
    }
  })

  try {
    await decoder.load()

    const audioStream = fs.createReadStream(audioFilePath)
    const response = await decoder.run(audioStream)

    const decodedFileBuffer = []

    await response
      .onUpdate(output => {
        const bytes = new Uint8Array(output.outputArray)
        decodedFileBuffer.push(bytes)
      })
      .onFinish(() => {
        fs.writeFileSync(outputFilePath, Buffer.concat(decodedFileBuffer))
        console.log('Decoded file saved to', outputFilePath)
      })
      .await()
  } finally {
    await decoder.unload()
  }
}

main().catch(console.error)
```

### 4. Run the example:

Make sure to set the correct `audioFilePath` and `outputFilePath` before running the example with the following command:

```bash
bare example.js
```

## Testing

### Running Unit Tests

To run unit tests (using the 'brittle-bare' runner):

```sh
npm run test:unit
```

### Test Coverage

To generate a unit test coverage report (using 'brittle' and 'istanbul'):

```sh
npm run coverage:unit
```

Or simply:

```sh
npm run coverage
```

Coverage reports are generated in the 'coverage/unit/' directory. Open the corresponding `index.html` file in your browser to view the detailed report.

## Glossary

* [**Bare** ](https://bare.pears.com/) – A lightweight, modular JavaScript runtime for desktop and mobile.
* [**QVACResponse**](https://github.com/tetherto/qvac-lib-response) – the response object used by QVAC API
* **QVAC** – Our decentralized AI SDK for building runtime-portable inference apps.

## Resources

* GitHub Repo: [tetherto/qvac](https://github.com/tetherto/qvac/tree/main/packages/decoder-audio)

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

*For questions or issues, please open an issue on the GitHub repository.*
