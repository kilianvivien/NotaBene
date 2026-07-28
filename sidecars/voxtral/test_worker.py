from __future__ import annotations

import io
import math
import subprocess
import sys
from pathlib import Path

import msgpack
import numpy as np

from worker import (
    MAX_FRAME_BYTES,
    float_to_pcm16,
    read_frame,
    safe_error_name,
    write_frame,
)


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


def test_import_diagnostics_expose_only_the_module_name() -> None:
    error = ImportError("path and loader details", name="missing.module")
    assert safe_error_name(error) == "ImportError[missing.module]"
    try:
        raise RuntimeError("Metal library unavailable")
    except RuntimeError as cause:
        native = ImportError("dlopen(/private/example/lib.dylib): image not found")
        native.__cause__ = cause
    assert safe_error_name(native) == (
        "ImportError[native-runtime: dlopen(<path>: image not found <- "
        "RuntimeError: Metal library unavailable]"
    )


def test_value_error_diagnostics_do_not_expose_exception_text() -> None:
    try:
        raise ValueError("private note contents")
    except ValueError as error:
        diagnostic = safe_error_name(error)
    assert diagnostic == "ValueError[model-generation]"
    assert "private note contents" not in diagnostic


def test_worker_shutdown_exits_cleanly() -> None:
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name("worker.py"))],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    write_frame(process.stdin, {"type": "ping"})
    assert read_frame(process.stdout) == {"type": "pong", "loaded": False}
    write_frame(process.stdin, {"type": "shutdown"})

    assert process.wait(timeout=5) == 0
    assert process.stderr.read() == b""
