from __future__ import annotations

import pytest

from tetherto.qvac_sdk import bare_rpc_transport
from tetherto.qvac_sdk.bare_rpc_transport import _CONTROL, _DATA, _frame, _FrameReader


def test_frames_split_across_single_bytes() -> None:
    stream = _frame(_DATA, b"first") + _frame(_DATA, b"second")
    reader = _FrameReader()
    frames: list[tuple[int, bytes]] = []
    for index in range(len(stream)):
        frames.extend(reader.feed(stream[index : index + 1]))
    assert frames == [(_DATA, b"first"), (_DATA, b"second")]


def test_control_frame_between_user_frames_keeps_its_place() -> None:
    stream = (
        _frame(_DATA, b"one")
        + _frame(_CONTROL, b'{"type":"ready"}')
        + _frame(_DATA, b"two")
    )
    assert _FrameReader().feed(stream) == [
        (_DATA, b"one"),
        (_CONTROL, b'{"type":"ready"}'),
        (_DATA, b"two"),
    ]


def test_empty_payload_frame() -> None:
    assert _FrameReader().feed(_frame(_DATA, b"")) == [(_DATA, b"")]


def test_zero_length_is_rejected() -> None:
    with pytest.raises(ValueError, match="out of range: 0"):
        _FrameReader().feed(b"\x00\x00\x00\x00")


def test_length_above_the_cap_is_rejected(monkeypatch) -> None:
    monkeypatch.setattr(bare_rpc_transport, "_MAX_FRAME_BYTES", 8)
    with pytest.raises(ValueError, match="out of range: 9"):
        _FrameReader().feed((9).to_bytes(4, "little"))
