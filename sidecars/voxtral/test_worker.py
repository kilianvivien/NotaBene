from __future__ import annotations

import io
import math

import numpy as np

from worker import MAX_FRAME_BYTES, float_to_pcm16, read_frame, write_frame


def test_protocol_round_trip() -> None:
    stream = io.BytesIO()
    envelope = {"type": "audio", "pcm": b"\x00\x01", "sequence": 3}
    write_frame(stream, envelope)
    stream.seek(0)
    assert read_frame(stream) == envelope


def test_rejects_oversized_frame() -> None:
    stream = io.BytesIO((MAX_FRAME_BYTES + 1).to_bytes(4, "little"))
    try:
        read_frame(stream)
    except ValueError:
        return
    raise AssertionError("oversized frame was accepted")


def test_pcm_conversion_is_finite_clamped_and_little_endian() -> None:
    pcm = float_to_pcm16(np.array([math.nan, -2.0, 0.0, 2.0], dtype=np.float32))
    assert np.frombuffer(pcm, dtype="<i2").tolist() == [0, -32767, 0, 32767]
