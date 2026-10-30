"""Python port of packages/sdk/examples/voice-assistant/voice-assistant.ts.

Real-time Voice Assistant: mic → Whisper (with Silero VAD) → Llama →
Supertonic TTS.

Speak a question; the VAD detects when you pause, the utterance is
transcribed, sent to the LLM, and the response is spoken back. The loop
continues until you press Ctrl+C. While the assistant is speaking, mic audio
is dropped so it does not hear itself.

The microphone and playback helpers the TypeScript example imports from
`audio/mic-input` and `tts/utils` are repeated inline. Playback runs in a
thread so the mic pipe keeps draining while the assistant speaks, which the
TypeScript example gets from Node's event loop.

Requirements: FFmpeg installed, microphone access, speakers.

RUN: python examples/voice_assistant.py
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
import shutil
import struct
import subprocess
import sys

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    completion,
    load_model,
    text_to_speech,
    transcribe_stream_session,
    unload_model,
)
from tetherto.qvac_sdk.models import (
    LLAMA_3_2_1B_INST_Q4_0,
    TTS_EN_SUPERTONIC_Q8_0,
    VAD_SILERO_5_1_2,
    WHISPER_TINY,
)

MIC_SAMPLE_RATE = 16000
TTS_SAMPLE_RATE = 44100

SYSTEM_PROMPT = (
    "You are a concise, friendly voice assistant. Keep responses under two "
    "sentences. Never use markdown, lists, or code blocks — your output will "
    "be spoken aloud."
)

# VAD parameters tuned for conversational speech without the assistant looping
# on its own echo. These defaults are deliberately conservative:
#   - threshold 0.6: less sensitive than Silero's default; avoids triggering
#     on TTS reverb bleeding into the mic or low-level background noise.
#   - min_speech_duration_ms 300: drops short clicks/breaths and stray words.
#   - min_silence_duration_ms 700: requires a longer quiet tail before
#     committing a segment. Crucial for preventing self-hearing feedback loops
#     where Whisper hallucinates content from near-silent audio.
#   - max_speech_duration_s 15: caps runaway utterances.
#   - speech_pad_ms 200: padding improves accuracy on utterance edges.
# If the assistant cuts you off mid-sentence, raise min_silence_duration_ms.
# If it keeps hallucinating / talking to itself, raise threshold to 0.7 and/or
# min_silence_duration_ms to 900.
VAD_PARAMS = {
    "threshold": 0.6,
    "min_speech_duration_ms": 300,
    "min_silence_duration_ms": 700,
    "max_speech_duration_s": 15.0,
    "speech_pad_ms": 200,
}

# Short grace period after TTS playback before we start listening again.
# Gives the speaker amp / room reverb a moment to fully settle so the first
# post-playback mic frames don't get transcribed as the tail of our own voice.
POST_PLAYBACK_COOLDOWN_MS = 300

# Minimum characters for an utterance to be considered meaningful. Whisper
# frequently hallucinates single words like "you", ".", or "Thanks." from
# silence or faint noise; these short phantoms are the main driver of the
# self-hearing feedback loop, so we drop them.
MIN_UTTERANCE_CHARS = 3


def is_meaningful_transcript(text: str) -> bool:
    trimmed = text.strip()
    if len(trimmed) == 0:
        return False
    if "[No speech detected]" in trimmed:
        return False
    # Whisper sometimes emits non-linguistic cues on silence, e.g. "[BLANK_AUDIO]".
    if re.fullmatch(r"\[[^\]]+\]", trimmed):
        return False
    # Strip punctuation/whitespace for the length check so ". . ." is rejected.
    letters = re.sub(r"[\W_]", "", trimmed)
    return len(letters) >= MIN_UTTERANCE_CHARS


# ── Microphone (audio/mic-input.ts) ──


def list_windows_audio_devices() -> list[str]:
    # ffmpeg lists DirectShow devices on stderr and always exits non-zero
    # because `-i dummy` is not a real input.
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-f",
            "dshow",
            "-list_devices",
            "true",
            "-i",
            "dummy",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    devices = []
    section = None
    for line in result.stderr.splitlines():
        # Old ffmpeg (≤ 4.3) prints section headers; new ffmpeg (≥ 4.4) tags
        # each device line with "(audio)" or "(video)".
        if "DirectShow audio devices" in line:
            section = "audio"
            continue
        if "DirectShow video devices" in line:
            section = "video"
            continue
        line_section = section
        if "(audio)" in line:
            line_section = "audio"
        elif "(video)" in line:
            line_section = "video"
        if line_section != "audio":
            continue
        # First quoted token is the device name. Alternative-name lines start
        # with `@device_...` and are filtered out.
        match = re.search(r'"([^"]+)"', line)
        if not match or match[1].startswith("@device"):
            continue
        devices.append(match[1])
    return devices


def get_audio_input_args() -> list[str]:
    override = os.environ.get("MIC_DEVICE")
    system = platform.system()
    if system == "Darwin":
        # AVFoundation device spec is `<video>:<audio>`. `:0` = default audio.
        return ["-f", "avfoundation", "-i", override or ":0"]
    if system == "Linux":
        # PulseAudio source name. `default` follows the system default mic.
        return ["-f", "pulse", "-i", override or "default"]
    if system == "Windows":
        if override:
            return ["-f", "dshow", "-i", f"audio={override}"]
        devices = list_windows_audio_devices()
        if not devices:
            raise RuntimeError(
                "No Windows audio input device found. List devices with:\n"
                "  ffmpeg -hide_banner -f dshow -list_devices true -i dummy\n"
                'Then set MIC_DEVICE="Your Device Name" and retry.'
            )
        return ["-f", "dshow", "-i", f"audio={devices[0]}"]
    raise RuntimeError(f"Unsupported platform: {system}")


async def start_microphone(sample_rate: int) -> asyncio.subprocess.Process:
    """Capture mono f32le audio from the default mic through ffmpeg."""
    return await asyncio.create_subprocess_exec(
        "ffmpeg",
        *get_audio_input_args(),
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "-sample_fmt",
        "flt",
        "-f",
        "f32le",
        "pipe:1",
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )


# ── Playback (tts/utils.ts) ──


def create_wav_header(data_length: int, sample_rate: int) -> bytes:
    """Create a WAV header for 16-bit mono PCM audio."""
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_length)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", data_length)
    )


def int16_array_to_buffer(samples) -> bytes:
    """Convert int16 PCM samples to little-endian bytes."""
    return struct.pack(
        f"<{len(samples)}h",
        *(max(-32768, min(32767, round(s))) for s in samples),
    )


def play_audio(audio_buffer: bytes) -> None:
    """Play a WAV buffer by streaming it into ffplay over stdin."""
    try:
        result = subprocess.run(
            [
                "ffplay",
                "-hide_banner",
                "-loglevel",
                "error",
                "-autoexit",
                "-nodisp",
                "-i",
                "pipe:0",
            ],
            input=audio_buffer,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "ffplay not found on PATH. Install ffmpeg (ffplay ships with it) and retry."
        ) from None
    if result.returncode != 0:
        raise RuntimeError(f"ffplay exited with code {result.returncode}")


# ── Main ──


async def main() -> int:
    for tool in ("ffmpeg", "ffplay"):
        if shutil.which(tool) is None:
            print(
                f"✖ {tool} not found on PATH. Install ffmpeg (ffplay ships with it) and retry.",
                file=sys.stderr,
            )
            return 1

    async with Client() as client:
        t = client.transport
        model_ids: list[str] = []
        ffmpeg = None
        try:
            print("▸ Loading whisper-tiny + Silero VAD...")
            asr_model_id = await load_model(
                t,
                model_src=WHISPER_TINY,
                model_config={
                    "vadModelSrc": VAD_SILERO_5_1_2,
                    "audio_format": "f32le",
                    "strategy": "greedy",
                    "n_threads": 4,
                    "language": "en",
                    "no_timestamps": True,
                    "suppress_blank": True,
                    "suppress_nst": True,
                    "temperature": 0.0,
                    "vad_params": VAD_PARAMS,
                },
            )
            model_ids.append(asr_model_id)

            print("▸ Loading Llama 3.2 1B...")
            llm_model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={"ctx_size": 4096},
            )
            model_ids.append(llm_model_id)

            print("▸ Loading Supertonic TTS...")
            tts_model_id = await load_model(
                t,
                model_src=TTS_EN_SUPERTONIC_Q8_0,
                model_config={
                    "ttsEngine": "supertonic",
                    "language": "en",
                    "voice": "F1",
                    "ttsSpeed": 1.05,
                    "ttsNumInferenceSteps": 5,
                },
            )
            model_ids.append(tts_model_id)

            print("▸ All models loaded.\n")

            ffmpeg = await start_microphone(MIC_SAMPLE_RATE)
            session = transcribe_stream_session(t, model_id=asr_model_id)

            history = [{"role": "system", "content": SYSTEM_PROMPT}]

            # Dropped-chunk gate: while the assistant is speaking we stop
            # feeding the mic stream into the ASR session. Using a flag (rather
            # than pausing the ffmpeg pipe) keeps the pipe drained so we never
            # accumulate stale audio, and the VAD starts fresh on the next turn.
            is_speaking = False

            async def pump_mic() -> None:
                while chunk := await ffmpeg.stdout.read(4096):
                    if not is_speaking:
                        session.write(chunk)

            pump = asyncio.create_task(pump_mic())

            print("▸ Listening. Speak a question and pause. Ctrl+C to quit.\n")

            async for raw_text in session:
                if not is_meaningful_transcript(raw_text):
                    continue
                user_text = raw_text.strip()

                print(f"▸ You: {user_text}")
                history.append({"role": "user", "content": user_text})

                is_speaking = True
                try:
                    print("▸ Assistant:")
                    run = completion(t, model_id=llm_model_id, history=history)
                    assistant_text = ""
                    async for event in run.events:
                        if event.type == "contentDelta":
                            sys.stdout.write(event.text)
                            sys.stdout.flush()
                            assistant_text += event.text
                    sys.stdout.write("\n")
                    history.append({"role": "assistant", "content": assistant_text})

                    spoken = assistant_text.strip()
                    if spoken:
                        request = TextToSpeechRequest.model_validate(
                            {
                                "type": "textToSpeech",
                                "modelId": tts_model_id,
                                "text": spoken,
                                "inputType": "text",
                                "stream": False,
                            }
                        )
                        samples: list[float] = []
                        async for response in text_to_speech(t, request):
                            samples.extend(response.buffer)
                        audio_data = int16_array_to_buffer(samples)
                        wav_buffer = (
                            create_wav_header(len(audio_data), TTS_SAMPLE_RATE)
                            + audio_data
                        )
                        await asyncio.to_thread(play_audio, wav_buffer)
                        # Cooldown keeps the mic gated briefly so speaker tail /
                        # room reverb doesn't feed into the next VAD segment.
                        await asyncio.sleep(POST_PLAYBACK_COOLDOWN_MS / 1000)
                except Exception as turn_error:
                    print(f"\n✖ Turn failed: {turn_error}", file=sys.stderr)
                finally:
                    is_speaking = False
                    print("\n▸ Listening...\n")

            pump.cancel()
        except asyncio.CancelledError:
            pass
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            print("\n\n▸ Stopping...")
            if ffmpeg is not None and ffmpeg.returncode is None:
                ffmpeg.kill()
            for model_id in reversed(model_ids):
                try:
                    await unload_model(t, model_id)
                except Exception:
                    pass
            print("▸ Done.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
