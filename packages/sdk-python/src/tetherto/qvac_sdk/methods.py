"""Public re-export of the generated typed RPC method stubs:

from tetherto.qvac_sdk.methods import heartbeat, load_model_with_progress
...
response = await heartbeat(transport, HeartbeatRequest())
"""

from __future__ import annotations

# Re-exports both the names and _generated.methods' own __all__, so
# `from tetherto.qvac_sdk.methods import *` downstream still respects it -- the
# __all__ import looks unused to a linter but is what makes that work.
from collections.abc import AsyncIterable, AsyncIterator

from ._generated import methods as _generated
from ._generated.methods import *  # noqa: F403
from ._generated.methods import __all__  # noqa: F401
from ._streams import tts_frame_with_samples
from ._transport import Transport
from .schemas import (
    TextToSpeechRequest,
    TextToSpeechResponse,
    TextToSpeechStreamRequest,
    TextToSpeechStreamResponse,
)

# The two speech methods shadow their generated stubs (defined after the star
# import, so they win here and in `tetherto.qvac_sdk`): the worker sends audio
# as base64 int16 `pcm` with an empty `buffer`, and callers of these methods
# read `response.buffer`. Same calling convention, frames decoded on the way.


async def text_to_speech(  # type: ignore[no-redef]  # noqa: F811
    transport: Transport, params: TextToSpeechRequest
) -> AsyncIterator[TextToSpeechResponse]:
    async for frame in _generated.text_to_speech(transport, params):
        yield tts_frame_with_samples(frame)


async def text_to_speech_stream(  # type: ignore[no-redef]  # noqa: F811
    transport: Transport, params: TextToSpeechStreamRequest, up: AsyncIterable[bytes]
) -> AsyncIterator[TextToSpeechStreamResponse]:
    async for frame in _generated.text_to_speech_stream(transport, params, up):
        yield tts_frame_with_samples(frame)
