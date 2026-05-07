# Real-time Voice Assistant

End-to-end voice assistant running fully locally:

```
microphone → Whisper (Silero VAD) → Llama 3.2 → Supertonic TTS → speakers
```

Each loop iteration:

1. The mic streams 16 kHz f32le audio into a `transcribeStream` session.
2. Silero VAD detects a pause and emits the transcribed utterance.
3. The utterance is appended to conversation history and sent to the LLM.
4. LLM tokens stream to stdout; the full response is sent to Supertonic.
5. TTS audio is played back through the system speaker.
6. While the assistant speaks, incoming mic audio is dropped so it does
   not transcribe itself.

## Run it

```bash
bun run examples/voice-assistant/voice-assistant.ts
```

Press `Ctrl+C` to quit. Models are downloaded on first run and cached
locally; subsequent runs work offline.

## Requirements

- **FFmpeg** (and **ffplay**, which ships with it) on `PATH` — `ffmpeg`
  captures mic audio, `ffplay` streams the TTS WAV buffer back out to
  the speakers. See [Installing FFmpeg](#installing-ffmpeg) below.
- **Microphone** access (on macOS, Terminal / your shell needs mic
  permission in _System Settings → Privacy & Security → Microphone_).
- **Speakers** connected and selected as the default output device.

### Installing FFmpeg

| Platform             | Command                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| macOS (Homebrew)     | `brew install ffmpeg`                                                                                |
| Debian / Ubuntu      | `sudo apt update && sudo apt install ffmpeg`                                                         |
| Fedora / RHEL        | `sudo dnf install ffmpeg` (enable [RPM Fusion](https://rpmfusion.org/Configuration) first if needed) |
| Arch Linux           | `sudo pacman -S ffmpeg`                                                                              |
| Windows (winget)     | `winget install Gyan.FFmpeg`                                                                         |
| Windows (Chocolatey) | `choco install ffmpeg`                                                                               |

Verify the install with:

```bash
ffmpeg -version
```

If `ffmpeg` is not on your `PATH` after install (common on Windows when
installed manually), download a static build from
[ffmpeg.org/download.html](https://ffmpeg.org/download.html) and add its
`bin/` directory to your `PATH`.

## Selecting a microphone (`MIC_DEVICE`)

By default the example picks the system default microphone on each OS:

- **macOS:** AVFoundation audio device `:0` (default mic).
- **Linux:** PulseAudio source `default`.
- **Windows:** the first DirectShow audio device reported by ffmpeg.

To use a different mic, set the `MIC_DEVICE` environment variable:

```bash
# macOS — pick by index (list with `ffmpeg -f avfoundation -list_devices true -i ""`)
MIC_DEVICE=":1" bun run examples/voice-assistant/voice-assistant.ts

# Linux — pick a PulseAudio source (list with `pactl list short sources`)
MIC_DEVICE="alsa_input.usb-Blue_Microphones_Yeti-00" \
  bun run examples/voice-assistant/voice-assistant.ts

# Windows (PowerShell) — pick by device name
#   List devices first:
#     ffmpeg -hide_banner -f dshow -list_devices true -i dummy
#   Then run with the exact name from that list:
$env:MIC_DEVICE = "Microphone (Realtek(R) Audio)"
bun run examples/voice-assistant/voice-assistant.ts
```

If Windows auto-detection can't find a device, the script prints the
`ffmpeg -list_devices` command for you. Auto-detection handles both the
old-format ("DirectShow audio devices" header) and new-format
("(audio)" per-line tag) ffmpeg output.

## Mobile / Expo

This example is **desktop-only** — it relies on spawning `ffmpeg` as a
subprocess and on Node's `child_process`, neither of which exist in
React Native / Expo. On mobile you'd feed PCM from `expo-av` (or a
native audio module) straight into `transcribeStream`. A dedicated
Expo example is tracked separately.

## Models used

| Stage | Model                    | Notes                                              |
| ----- | ------------------------ | -------------------------------------------------- |
| ASR   | `WHISPER_TINY`           | Fast, English-only, good enough for short commands |
| VAD   | `VAD_SILERO_5_1_2`       | Silero v5.1.2, loaded alongside Whisper            |
| LLM   | `LLAMA_3_2_1B_INST_Q4_0` | 1B instruct, 4-bit quantized                       |
| TTS   | Supertonic2 (English)    | 44.1 kHz general-purpose TTS                       |

## VAD tuning

The defaults are deliberately conservative to prevent the assistant from
hearing its own TTS output and looping on itself (a classic failure
mode when mic and speakers share the same room):

```ts
{
  threshold: 0.6,              // less sensitive than Silero's default
  min_speech_duration_ms: 300, // drops short clicks / breaths / stray words
  min_silence_duration_ms: 700,// long quiet tail before committing a segment
  max_speech_duration_s: 15.0, // caps runaway utterances
  speech_pad_ms: 200,          // edge padding improves accuracy
}
```

Two other safeguards against the self-hearing loop:

- **Mic gate during TTS** — incoming audio is dropped while the assistant
  speaks, so it cannot transcribe its own output.
- **Post-playback cooldown** (`POST_PLAYBACK_COOLDOWN_MS = 300`) — keeps
  the mic gated for a moment after playback so speaker/room reverb
  doesn't bleed into the next VAD segment.
- **Minimum utterance length** (`MIN_UTTERANCE_CHARS = 3`) — drops
  single-character or two-letter phantom transcripts like `"you"` or
  `"."` that Whisper commonly hallucinates from near-silent audio.

### Troubleshooting

| Symptom                                     | Fix                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Assistant cuts you off mid-sentence         | Raise `min_silence_duration_ms` to `900–1000`                                                                    |
| Assistant talks over itself / loops forever | Raise `threshold` to `0.7`; raise `min_silence_duration_ms` to `900`; raise `POST_PLAYBACK_COOLDOWN_MS` to `500` |
| Slow to respond after you stop talking      | Lower `min_silence_duration_ms` to `500`                                                                         |
| Picks up background typing / keyboard       | Raise `threshold` to `0.7` and `min_speech_duration_ms` to `400`                                                 |
| Short commands (“yes”, “no”) are ignored    | Lower `MIN_UTTERANCE_CHARS` to `2`                                                                               |

If you're running with headphones (mic cannot hear the speaker),
you can loosen everything: `threshold: 0.5`,
`min_silence_duration_ms: 500`, `POST_PLAYBACK_COOLDOWN_MS: 0`.

## Customizing

- **Different LLM:** swap `LLAMA_3_2_1B_INST_Q4_0` for any `*_LLM`
  model constant from `@qvac/sdk`. Larger models give better answers at
  the cost of latency.
- **Different voice:** replace the Supertonic constants with another
  TTS model (e.g. Chatterbox — see `examples/tts/chatterbox.ts`).
- **System prompt:** edit `SYSTEM_PROMPT` at the top of the script.
  The default instructs the LLM to be concise and avoid markdown so
  responses are pleasant to listen to.
