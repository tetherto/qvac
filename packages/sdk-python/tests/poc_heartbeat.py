#!/usr/bin/env python3
"""
QVAC RPC proof-of-concept — bare worker spawn + bare-rpc wire encoding/decoding.

`QvacWorker` is deliberately just that: process lifecycle, framing, and the
three wire call shapes (unary/stream/duplex). Everything method-specific —
building a typed request, picking the right call shape, parsing the typed
response — lives in the real package (`qvac.methods`, `qvac.schemas`, `qvac.api`,
`qvac.models`) and is exercised below via `poc_transport.PocTransport`, the
same adapter the test suite uses. This file is the only thing standing in
for the not-yet-built production transport (bare-rpc-python); once that
lands, `QvacWorker` is what it replaces — nothing above it should need to
change.

Asyncio-native throughout, matching the JS SDK (Promises / async iterators)
rather than blocking sockets + sync generators.

RUN:
  python3 poc_heartbeat.py                                             # heartbeat + a default completion
  QVAC_POC_MODEL="/path/to/model.gguf" python3 poc_heartbeat.py        # completion against a specific local model

Wire format (bare-rpc: lib/messages.js, lib/constants.js):
  frame          = uint32(len, little-endian) + body
  body(REQUEST)  = uint(1) uint(id) uint(command) uint(0) uint(len) <json>
  body(RESPONSE) = uint(2) uint(id) bool(err) uint(stream) [<err> | uint(len) <json>]
  body(STREAM)   = uint(3) uint(id) uint(flags) [uint(len) <json> if flags & DATA]
  `uint` is a varint; payloads are UTF-8 JSON. Application errors come back
  in-band as a normal reply {"type":"error","message":...}.
"""

import array
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import traceback
import wave
from pathlib import Path
from typing import cast

_SRC_DIR = str(Path(__file__).resolve().parent.parent / "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

# These import qvac itself, which only resolves once the sys.path
# insert above has run -- this is a standalone script, not an
# installed package, so they can't move above it.
from poc_transport import PocTransport  # noqa: E402

from qvac.methods import (  # noqa: E402
    completion_stream,
    embed,
    heartbeat,
    load_model,
    text_to_speech_stream,
    transcribe,
    transcribe_stream,
)
from qvac.models import QWEN3_600M_INST_Q4  # noqa: E402
from qvac.schemas import (  # noqa: E402
    CompletionStreamRequest,
    EmbedRequest,
    HeartbeatRequest,
    LoadModelRequest,
    ModelType,
    TextToSpeechStreamRequest,
    TranscribeRequest,
    TranscribeStreamRequest,
)

# ============================================================================
# 0. Where the worker and the Bare runtime live
# ============================================================================

SDK = os.environ.get(
    "QVAC_POC_SDK_DIR",
    str(Path(__file__).resolve().parent.parent.parent / "sdk"),
)
BARE = f"{SDK}/node_modules/bare-runtime-darwin-arm64/bin/bare"
WORKER = f"{SDK}/dist/server/worker.js"
DEFAULT_AUDIO = (
    f"{SDK}/e2e/assets/audio/transcription-short-wav.wav"  # an SDK e2e fixture
)

REQUEST, RESPONSE, STREAM = 1, 2, 3  # bare-rpc message types

# stream flags (a STREAM frame's `flags` field OR's these together)
S_OPEN, S_CLOSE, S_PAUSE, S_RESUME = 0x1, 0x2, 0x4, 0x8
S_DATA, S_END, S_DESTROY, S_ERROR = 0x10, 0x20, 0x40, 0x80
S_REQUEST, S_RESPONSE = 0x100, 0x200  # which half of the call the stream belongs to

DEBUG = bool(os.environ.get("QVAC_POC_DEBUG"))  # dump raw frame headers


# ============================================================================
# 1. compact-encoding — only the few primitives the envelope uses
# ============================================================================


def enc_uint(n: int) -> bytes:
    if n <= 0xFC:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + n.to_bytes(2, "little")
    if n <= 0xFFFFFFFF:
        return b"\xfe" + n.to_bytes(4, "little")
    return b"\xff" + n.to_bytes(8, "little")


def dec_uint(buf: bytes, pos: int):
    a = buf[pos]
    pos += 1
    if a < 0xFD:
        return a, pos
    if a == 0xFD:
        return int.from_bytes(buf[pos : pos + 2], "little"), pos + 2
    if a == 0xFE:
        return int.from_bytes(buf[pos : pos + 4], "little"), pos + 4
    return int.from_bytes(buf[pos : pos + 8], "little"), pos + 8


def dec_utf8(buf: bytes, pos: int):
    n, pos = dec_uint(buf, pos)
    return buf[pos : pos + n].decode("utf-8"), pos + n


def dec_int(buf: bytes, pos: int):
    u, pos = dec_uint(buf, pos)
    return (u >> 1) ^ -(u & 1), pos  # zigzag


def _short(s: str, n: int = 400) -> str:
    s = str(s)
    return s if len(s) <= n else s[:n] + " …[truncated]"


# ============================================================================
# 2. Minimal bare-rpc client over a Unix socket
#    The worker connects back to *us*, so we are the socket server.
# ============================================================================


class QvacWorker:
    def __init__(self):
        self._sock_path = os.path.join(
            tempfile.gettempdir(), f"qvac-poc-{os.getpid()}.sock"
        )
        self._server: asyncio.AbstractServer | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._id = 0
        self._log_path = os.path.join(
            tempfile.gettempdir(), f"qvac-poc-worker-{os.getpid()}.log"
        )
        self._log_fh = None

    # ---- lifecycle -------------------------------------------------------

    async def start(self):
        if os.path.exists(self._sock_path):
            os.unlink(self._sock_path)

        connected: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def on_client(reader, writer):
            self._reader, self._writer = reader, writer
            if not connected.done():
                connected.set_result(None)

        self._server = await asyncio.start_unix_server(on_client, path=self._sock_path)

        # The worker reads its socket path (+ home dir) from a JSON arg,
        # parsed as Bare.argv[2] (server/env.ts).
        config = json.dumps(
            {
                "QVAC_IPC_SOCKET_PATH": self._sock_path,
                "HOME_DIR": os.path.expanduser("~"),
            }
        )
        # worker stdout+stderr -> a file, so reading its logs never blocks on a live pipe
        self._log_fh = open(self._log_path, "wb")
        self._proc = await asyncio.create_subprocess_exec(
            BARE,
            WORKER,
            config,
            cwd=SDK,
            stdout=self._log_fh,
            stderr=subprocess.STDOUT,
        )
        await asyncio.wait_for(connected, timeout=30)  # worker dials back in
        return self

    async def close(self):
        if self._proc:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
        if self._writer:
            self._writer.close()
        if self._server:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=5)
            except asyncio.TimeoutError:
                pass  # best-effort teardown; a slow-to-close socket isn't fatal
        if self._log_fh:
            self._log_fh.close()
        if os.path.exists(self._sock_path):
            os.unlink(self._sock_path)

    async def __aenter__(self):
        return await self.start()

    async def __aexit__(self, *exc):
        await self.close()

    def worker_logs(self) -> str:
        try:
            with open(self._log_path, errors="replace") as f:
                return f.read()
        except OSError:
            return ""

    # ---- framing ---------------------------------------------------------

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    async def _send_frame(self, body: bytes):
        assert self._writer is not None, "_send_frame called before start()"
        self._writer.write(len(body).to_bytes(4, "little") + body)
        await self._writer.drain()

    async def _send_request(self, payload: dict) -> int:
        req_id = self._next_id()
        data = json.dumps(payload).encode("utf-8")
        # command == id: the server ignores `command` and routes on payload.type
        body = (
            enc_uint(REQUEST)
            + enc_uint(req_id)
            + enc_uint(req_id)
            + enc_uint(0)
            + enc_uint(len(data))
            + data
        )
        await self._send_frame(body)
        return req_id

    async def _send_stream_ctrl(self, req_id: int, flags: int):
        await self._send_frame(enc_uint(STREAM) + enc_uint(req_id) + enc_uint(flags))

    async def _send_request_open(self, req_id: int):
        # open the client->server request stream: a REQUEST msg with stream=OPEN
        # and no data (mirrors bare-rpc OutgoingStream._open for a REQUEST stream).
        await self._send_frame(
            enc_uint(REQUEST) + enc_uint(req_id) + enc_uint(req_id) + enc_uint(S_OPEN)
        )

    async def _send_stream_data(self, req_id: int, flags: int, data: bytes):
        await self._send_frame(
            enc_uint(STREAM)
            + enc_uint(req_id)
            + enc_uint(flags)
            + enc_uint(len(data))
            + data
        )

    async def _recv(self, n: int) -> bytes:
        assert self._reader is not None, "_recv called before start()"
        try:
            return await self._reader.readexactly(n)
        except asyncio.IncompleteReadError:
            raise RuntimeError("worker closed the socket") from None

    async def _read_message(self) -> dict:
        frame_len = int.from_bytes(await self._recv(4), "little")
        body = await self._recv(frame_len)
        if DEBUG:
            print(f"[frame] len={frame_len} head={body[:24].hex()}", file=sys.stderr)
        mtype, pos = dec_uint(body, 0)
        msg_id, pos = dec_uint(body, pos)

        if mtype == RESPONSE:
            err = body[pos]
            pos += 1  # bool: 1 byte
            stream, pos = dec_uint(body, pos)
            if err:
                raise RuntimeError(self._decode_error(body, pos))
            # stream == 0 -> a unary reply carrying data.
            # stream != 0 -> a "the response is a stream" marker, no data; the
            #               actual payloads arrive as STREAM frames after this.
            data = None
            if stream == 0:
                data_len, pos = dec_uint(body, pos)
                data = body[pos : pos + data_len]
            return {"kind": "response", "id": msg_id, "stream": stream, "data": data}

        if mtype == STREAM:
            flags, pos = dec_uint(body, pos)
            if flags & S_ERROR:
                raise RuntimeError(self._decode_error(body, pos))
            data = None
            if flags & S_DATA:
                data_len, pos = dec_uint(body, pos)
                data = body[pos : pos + data_len]
            return {"kind": "stream", "id": msg_id, "flags": flags, "data": data}

        return {
            "kind": "request",
            "id": msg_id,
        }  # server->client callback (phase-2 tools)

    @staticmethod
    def _decode_error(body: bytes, pos: int) -> str:
        msg, pos = dec_utf8(body, pos)
        code, pos = dec_utf8(body, pos)
        errno, pos = dec_int(body, pos)
        return f"bare-rpc error frame: {msg} (code={code!r} errno={errno})"

    @staticmethod
    def _json_or_raise(data: bytes):
        """Parse a JSON payload; the SDK reports failures in-band as {"type":"error"}."""
        obj = json.loads(data.decode("utf-8"))
        if isinstance(obj, dict) and obj.get("type") == "error":
            raise RuntimeError("worker: " + _short(obj.get("message", "unknown error")))
        return obj

    # ---- the three wire call shapes -----------------------------------------

    async def call(self, payload: dict) -> dict:
        """Unary: send a request, wait for its single reply, return parsed JSON."""
        req_id = await self._send_request(payload)
        while True:
            msg = await self._read_message()
            if msg["kind"] == "response" and msg["id"] == req_id:
                return self._json_or_raise(msg["data"])

    async def call_stream(self, payload: dict):
        """Server-stream: send the request, OPEN + RESUME the response stream, then
        yield the newline-delimited JSON objects the worker pushes, until it ENDs."""
        req_id = await self._send_request(payload)
        await self._send_stream_ctrl(req_id, S_RESPONSE | S_OPEN)
        await self._send_stream_ctrl(req_id, S_RESPONSE | S_RESUME)

        buffer = ""
        while True:
            msg = await self._read_message()
            if msg["id"] != req_id:
                continue
            if msg["kind"] == "response":
                if msg["stream"] == 0:  # a real unary-style terminal reply
                    if msg["data"]:
                        yield self._json_or_raise(msg["data"])
                    return
                continue  # "response is a stream" marker; DATA frames follow
            if msg["kind"] != "stream":
                continue
            if msg["data"]:
                buffer += msg["data"].decode("utf-8")
                lines = buffer.split("\n")
                buffer = lines.pop()  # keep the partial line
                for line in lines:
                    if line.strip():
                        yield self._json_or_raise(line.encode("utf-8"))
            if msg["flags"] & (S_END | S_CLOSE):
                if buffer.strip():
                    yield self._json_or_raise(buffer.encode("utf-8"))
                return

    async def _duplex_call(self, payload_obj, up_chunks):
        # DUPLEX: open a client->server request stream (first chunk = the JSON
        # payload, then `up_chunks`), open the server->client response stream, and
        # yield the response events. Both halves share one req id; REQUEST-masked
        # STREAM frames go up, RESPONSE-masked frames come down.
        req_id = self._next_id()
        payload = json.dumps(payload_obj).encode("utf-8")
        await self._send_request_open(req_id)  # open client->server stream
        await self._send_stream_ctrl(
            req_id, S_RESPONSE | S_OPEN
        )  # open server->client stream
        await self._send_stream_ctrl(req_id, S_RESPONSE | S_RESUME)
        await self._send_stream_data(
            req_id, S_REQUEST | S_DATA, payload
        )  # 1st chunk = request JSON
        async for chunk in up_chunks:
            await self._send_stream_data(req_id, S_REQUEST | S_DATA, chunk)
        await self._send_stream_ctrl(req_id, S_REQUEST | S_END)  # done sending

        buffer = ""
        while True:
            msg = await self._read_message()
            if msg["id"] != req_id:
                continue
            if msg["kind"] == "response":
                if msg["stream"] == 0 and msg["data"]:
                    yield self._json_or_raise(msg["data"])
                    return
                continue  # response-stream-open marker
            if msg["kind"] != "stream":
                continue
            if msg["data"]:
                buffer += msg["data"].decode("utf-8")
                lines = buffer.split("\n")
                buffer = lines.pop()
                for line in lines:
                    if line.strip():
                        yield self._json_or_raise(line.encode("utf-8"))
            if msg["flags"] & (S_END | S_CLOSE):
                if buffer.strip():
                    yield self._json_or_raise(buffer.encode("utf-8"))
                return


async def _as_async_iter(items):
    """Wraps a plain sync iterable of chunks (e.g. a list) as the AsyncIterable
    the Transport protocol's call_duplex expects."""
    for item in items:
        yield item


# ============================================================================
# 3. Demo — everything method-specific goes through the real typed layer
#    (qvac.methods / qvac.models), via PocTransport(w). QvacWorker
#    itself is never touched below except to construct the transport.
# ============================================================================


def _dump_failure(w, label, e):
    print(f"\n[poc] {label} failed: {e}", file=sys.stderr)
    traceback.print_exc()
    logs = w.worker_logs()
    if logs.strip():
        print("---- worker logs (tail) ----\n" + _short(logs, 2000), file=sys.stderr)


async def _load(transport, model_src, model_type, model_config=None):
    request = LoadModelRequest.model_validate(
        {
            "type": "loadModel",
            "modelSrc": model_src,
            "modelType": model_type,
            "modelConfig": model_config or {},
        }
    )
    response = await load_model(transport, request)
    if not response.success:
        raise RuntimeError(f"loadModel failed: {response.error}")
    return response.model_id


async def demo_completion(w, model):
    transport = PocTransport(w)
    print(f"[loadModel] loading LLM {model} ...")
    model_id = await _load(transport, model, ModelType.llamacpp_completion)
    print(f"[loadModel] -> modelId={model_id!r}\n")

    print("[completion] streaming 'Say hello in five words.':")
    request = CompletionStreamRequest.model_validate(
        {
            "type": "completionStream",
            "modelId": model_id,
            "history": [{"role": "user", "content": "Say hello in five words."}],
            "stream": True,
        }
    )
    text = ""
    async for chunk in completion_stream(transport, request):
        for event in chunk.events:
            if event.type == "contentDelta":
                text += event.text
                sys.stdout.write(event.text)
                sys.stdout.flush()
    print(f"\n[completion] full text -> {text!r}")


async def demo_embed(w, model):
    transport = PocTransport(w)
    print(f"[loadModel] loading embedding model {model} ...")
    model_id = await _load(transport, model, ModelType.llamacpp_embedding)
    print(f"[loadModel] -> modelId={model_id!r}")

    request = EmbedRequest.model_validate(
        {"type": "embed", "modelId": model_id, "text": "hello world"}
    )
    response = await embed(transport, request)
    if not response.success:
        raise RuntimeError(f"embed failed: {response.error}")
    # embedding is list[float] | list[list[float]], keyed on whether the
    # request's `text` was a string or an array -- always a string above,
    # so this is always the flat shape.
    vec = cast("list[float]", response.embedding)
    print(
        f"[embed] 'hello world' -> dim={len(vec)}, first 5={[round(x, 4) for x in vec[:5]]}"
    )


async def demo_transcribe(w, model):
    transport = PocTransport(w)
    audio = os.environ.get("QVAC_POC_AUDIO", DEFAULT_AUDIO)
    print(f"[loadModel] loading transcription model {model} ...")
    model_id = await _load(transport, model, ModelType.parakeet_transcription)
    print(f"[loadModel] -> modelId={model_id!r}")
    print(f"[transcribe] {audio}:")

    request = TranscribeRequest.model_validate(
        {
            "type": "transcribe",
            "modelId": model_id,
            "audioChunk": {"type": "filePath", "value": audio},
        }
    )
    text = ""
    async for response in transcribe(transport, request):
        if response.text:
            text += response.text
    print(f"[transcribe] -> {text!r}")


def _wav_to_pcm_16k_mono(path, chunk_ms=100, fmt=None):
    """Decode a 16-bit PCM wav to 16 kHz mono, as int16 or float32 (QVAC_POC_PCM)."""
    fmt = fmt or os.environ.get("QVAC_POC_PCM", "i16")
    with wave.open(path, "rb") as wf:
        ch, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise RuntimeError(f"PoC expects 16-bit PCM wav (sampwidth=2), got {width}")
    samples = array.array("h")
    samples.frombytes(raw)
    mono = array.array("h", samples[0::ch]) if ch > 1 else samples  # take first channel
    target = 16000
    if rate != target and rate % target == 0:
        mono = array.array("h", mono[0 :: (rate // target)])  # crude decimation
    if fmt == "f32":
        data = array.array("f", (s / 32768.0 for s in mono)).tobytes()
        sample_bytes = 4
    else:  # int16 (default)
        data = mono.tobytes()
        sample_bytes = 2
    per_chunk = int(target * chunk_ms / 1000) * sample_bytes
    return (
        [data[i : i + per_chunk] for i in range(0, len(data), per_chunk)],
        target,
        fmt,
    )


async def demo_transcribe_stream(w, model):
    # parakeet duplex needs: a TRUE 16 kHz mono f32le stream (resample non-16k with
    # ffmpeg first), 1 s chunks, `emitPartials` so it emits per-chunk text, and
    # ~1.5 s of trailing silence so the stream finalizes.
    transport = PocTransport(w)
    audio = os.environ.get("QVAC_POC_AUDIO", DEFAULT_AUDIO)
    chunk_ms = 1000
    chunks, rate, fmt = _wav_to_pcm_16k_mono(audio, chunk_ms=chunk_ms, fmt="f32")
    per_chunk = int(rate * chunk_ms / 1000) * 4
    silence = bytes(int(rate * 1.5) * 4)
    chunks += [silence[i : i + per_chunk] for i in range(0, len(silence), per_chunk)]

    print(f"[loadModel] loading transcription model {model} ...")
    model_id = await _load(transport, model, ModelType.parakeet_transcription)
    print(f"[loadModel] -> modelId={model_id!r}")
    print(f"[transcribeStream] DUPLEX: {rate}Hz mono {fmt}, {len(chunks)} chunks:")

    request = TranscribeStreamRequest.model_validate(
        {
            "type": "transcribeStream",
            "modelId": model_id,
            "parakeetStreamingConfig": {"chunkMs": chunk_ms, "emitPartials": True},
        }
    )
    text = ""
    async for response in transcribe_stream(transport, request, _as_async_iter(chunks)):
        if DEBUG:
            print(f"[event] {response}", file=sys.stderr)
        piece = response.text or (response.segment.text if response.segment else None)
        if piece:
            text += piece
            sys.stdout.write(piece)
            sys.stdout.flush()
    print(f"\n[transcribeStream] -> {text!r}")


def _write_wav(path, samples, rate):
    peak = max((abs(s) for s in samples), default=0)
    if peak <= 4:  # float [-1, 1]
        ints = array.array(
            "h", (max(-32768, min(32767, int(s * 32767))) for s in samples)
        )
    else:  # already ~int16 scale
        ints = array.array("h", (max(-32768, min(32767, int(s))) for s in samples))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(ints.tobytes())


async def demo_tts_stream(w, model):
    transport = PocTransport(w)
    text = os.environ.get(
        "QVAC_POC_TTS_TEXT", "Hello from QVAC. This is streaming text to speech."
    )
    print(f"[loadModel] loading TTS model {model} ...")
    model_id = await _load(
        transport,
        model,
        ModelType.tts_ggml,
        model_config={"ttsEngine": "supertonic", "language": "en"},
    )
    print(f"[loadModel] -> modelId={model_id!r}")
    print(f"[textToSpeechStream] DUPLEX: synthesizing {text!r}")

    request = TextToSpeechStreamRequest.model_validate(
        {"type": "textToSpeechStream", "modelId": model_id}
    )
    samples, rate, events = [], None, 0
    async for response in text_to_speech_stream(
        transport, request, _as_async_iter([text.encode("utf-8")])
    ):
        events += 1
        if DEBUG:
            print(
                f"[event] buf={len(response.buffer)} done={response.done}",
                file=sys.stderr,
            )
        samples.extend(response.buffer)
        stats = response.stats
        if stats and stats.total_samples and stats.audio_duration:
            cand = stats.total_samples / (stats.audio_duration / 1000)  # ms -> s
            if 8000 <= cand <= 96000:
                rate = round(cand)
    rate = rate or 44100
    print(
        f"[textToSpeechStream] -> {events} events, {len(samples)} audio samples "
        f"(~{len(samples) / rate:.2f}s @ {rate}Hz)"
    )
    if samples:
        out = os.path.join(tempfile.gettempdir(), "qvac-poc-tts.wav")
        _write_wav(out, samples, rate)
        print(f"[textToSpeechStream] wrote {out} — play it to verify real speech")


# capability -> (env var pointing at a model, a default modelSrc when unset, demo fn).
# completion defaults to a real registry constant so the PoC has something to run
# out of the box; the rest need a local model path since no cached constant exists
# for them here. Add cases here one at a time.
CASES = [
    ("completion", "QVAC_POC_MODEL", QWEN3_600M_INST_Q4.src, demo_completion),
    ("embed", "QVAC_POC_EMBED_MODEL", None, demo_embed),
    ("transcribe", "QVAC_POC_STT_MODEL", None, demo_transcribe),
    ("transcribe-stream", "QVAC_POC_STT_STREAM_MODEL", None, demo_transcribe_stream),
    ("tts-stream", "QVAC_POC_TTS_MODEL", None, demo_tts_stream),
]


async def main():
    async with QvacWorker() as w:
        transport = PocTransport(w)
        print("[poc] worker connected\n")
        heartbeat_response = await heartbeat(
            transport, HeartbeatRequest(type="heartbeat")
        )
        print(f"[heartbeat] -> {heartbeat_response}\n")

        ran = False
        for label, env_var, default, fn in CASES:
            model = os.environ.get(env_var, default)
            if not model:
                continue
            ran = True
            try:
                await fn(w, model)
                print()
            except Exception as e:
                _dump_failure(w, label, e)
                raise
        if not ran:
            print(
                "[poc] set QVAC_POC_EMBED_MODEL / QVAC_POC_STT_MODEL / etc. to run more cases."
            )


if __name__ == "__main__":
    asyncio.run(main())
