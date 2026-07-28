"""NotaBene Voxtral worker.

Stdout is protocol-only. The process has no HTTP server and receives the exact
model directory from Rust after an immutable-revision handshake.
"""

from __future__ import annotations

import math
import os
import queue
import struct
import sys
import threading
from pathlib import Path
from typing import Any, BinaryIO

import msgpack
import numpy as np

PROTOCOL_VERSION = 1
SAMPLE_RATE_HZ = 24_000
MAX_FRAME_BYTES = 2 * 1024 * 1024
VOICES = (
    "casual_male",
    "casual_female",
    "cheerful_female",
    "neutral_male",
    "neutral_female",
    "fr_male",
    "fr_female",
    "es_male",
    "es_female",
    "de_male",
    "de_female",
    "it_male",
    "it_female",
    "pt_male",
    "pt_female",
    "nl_male",
    "nl_female",
    "ar_male",
    "hi_male",
    "hi_female",
)


def read_frame(stream: BinaryIO) -> dict[str, Any]:
    prefix = stream.read(4)
    if not prefix:
        raise EOFError
    if len(prefix) != 4:
        raise ValueError("truncated frame")
    (size,) = struct.unpack("<I", prefix)
    if size == 0 or size > MAX_FRAME_BYTES:
        raise ValueError("invalid frame size")
    payload = stream.read(size)
    if len(payload) != size:
        raise ValueError("truncated frame")
    value = msgpack.unpackb(payload, raw=False)
    if not isinstance(value, dict):
        raise ValueError("invalid envelope")
    return value


_output_lock = threading.Lock()


def write_frame(stream: BinaryIO, value: dict[str, Any]) -> None:
    payload = msgpack.packb(value, use_bin_type=True)
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    with _output_lock:
        stream.write(struct.pack("<I", len(payload)))
        stream.write(payload)
        stream.flush()


def float_to_pcm16(audio: Any) -> bytes:
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    samples = np.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    return np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class Worker:
    def __init__(self) -> None:
        self.commands: queue.Queue[dict[str, Any]] = queue.Queue()
        self.cancelled: set[str] = set()
        self.cancel_lock = threading.Lock()
        self.model: Any | None = None
        self.model_directory: Path | None = None
        self.model_id = ""
        self.model_revision = ""
        self.stopping = False

    def reader(self) -> None:
        try:
            while not self.stopping:
                command = read_frame(sys.stdin.buffer)
                if command.get("type") == "cancel":
                    request_id = str(command.get("request_id", ""))
                    with self.cancel_lock:
                        self.cancelled.add(request_id)
                else:
                    self.commands.put(command)
        except (EOFError, BrokenPipeError):
            self.stopping = True
            self.commands.put({"type": "shutdown"})
        except Exception as error:
            # No request content or audio is included in this diagnostic.
            print(f"protocol reader failed: {type(error).__name__}", file=sys.stderr)
            self.stopping = True
            self.commands.put({"type": "shutdown"})

    def is_cancelled(self, request_id: str) -> bool:
        with self.cancel_lock:
            return request_id in self.cancelled

    def hello(self, command: dict[str, Any]) -> None:
        if command.get("protocol_version") != PROTOCOL_VERSION:
            raise ValueError("protocol version mismatch")
        model_directory = Path(str(command.get("model_directory", ""))).resolve()
        if not model_directory.is_dir() or not (model_directory / "manifest.json").is_file():
            raise ValueError("model directory is not an activated revision")
        self.model_directory = model_directory
        self.model_id = str(command.get("expected_model_id", ""))
        self.model_revision = str(command.get("expected_model_revision", ""))
        write_frame(
            sys.stdout.buffer,
            {
                "type": "ready",
                "protocol_version": PROTOCOL_VERSION,
                "runtime_version": "notabene-voxtral-worker/1",
                "model_id": self.model_id,
                "model_revision": self.model_revision,
                "voices": list(VOICES),
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "loaded": False,
            },
        )

    def load(self) -> None:
        if self.model_directory is None:
            raise ValueError("hello required before load")
        if self.model is None:
            write_frame(sys.stdout.buffer, {"type": "loading_progress", "stage": "import"})
            # Import lazily so protocol and packaging tests do not initialize MLX.
            from mlx_audio.tts.utils import load

            write_frame(sys.stdout.buffer, {"type": "loading_progress", "stage": "weights"})
            self.model = load(str(self.model_directory))
        write_frame(
            sys.stdout.buffer,
            {
                "type": "ready",
                "protocol_version": PROTOCOL_VERSION,
                "runtime_version": "notabene-voxtral-worker/1",
                "model_id": self.model_id,
                "model_revision": self.model_revision,
                "voices": list(VOICES),
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "loaded": True,
            },
        )

    def synthesize(self, command: dict[str, Any]) -> None:
        if self.model is None:
            raise ValueError("model is not loaded")
        request_id = str(command.get("request_id", ""))
        voice_id = str(command.get("voice_id", ""))
        text = str(command.get("text", ""))
        chunk_seconds = float(command.get("chunk_seconds", 1.0))
        if not request_id or not text.strip() or voice_id not in VOICES:
            raise ValueError("invalid synthesis request")
        if not math.isfinite(chunk_seconds) or not 0.5 <= chunk_seconds <= 1.5:
            raise ValueError("invalid streaming interval")

        write_frame(
            sys.stdout.buffer,
            {
                "type": "started",
                "request_id": request_id,
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "channels": 1,
                "encoding": "pcm_s16le",
            },
        )
        sequence = 0
        total_samples = 0
        for result in self.model.generate(
            text=text,
            voice=voice_id,
            stream=True,
            streaming_interval=chunk_seconds,
            verbose=False,
        ):
            if self.is_cancelled(request_id):
                write_frame(
                    sys.stdout.buffer,
                    {"type": "cancelled", "request_id": request_id},
                )
                return
            pcm = float_to_pcm16(result.audio)
            sample_count = len(pcm) // 2
            if sample_count == 0:
                continue
            write_frame(
                sys.stdout.buffer,
                {
                    "type": "audio",
                    "request_id": request_id,
                    "sequence": sequence,
                    "pcm": pcm,
                    "sample_count": sample_count,
                },
            )
            sequence += 1
            total_samples += sample_count
            write_frame(
                sys.stdout.buffer,
                {
                    "type": "generation_progress",
                    "request_id": request_id,
                    "generated_samples": total_samples,
                },
            )
        write_frame(
            sys.stdout.buffer,
            {
                "type": "done",
                "request_id": request_id,
                "total_samples": total_samples,
                "duration_ms": round(total_samples / SAMPLE_RATE_HZ * 1000),
            },
        )

    def run(self) -> int:
        threading.Thread(target=self.reader, name="protocol-reader", daemon=True).start()
        while not self.stopping:
            command = self.commands.get()
            kind = command.get("type")
            try:
                if kind == "hello":
                    self.hello(command)
                elif kind == "load":
                    self.load()
                elif kind == "synthesize":
                    self.synthesize(command)
                elif kind == "ping":
                    write_frame(sys.stdout.buffer, {"type": "pong", "loaded": self.model is not None})
                elif kind == "unload":
                    self.model = None
                    write_frame(sys.stdout.buffer, {"type": "unloaded"})
                elif kind == "shutdown":
                    self.stopping = True
                else:
                    raise ValueError("unknown command")
            except Exception as error:
                write_frame(
                    sys.stdout.buffer,
                    {
                        "type": "error",
                        "request_id": str(command.get("request_id", "")),
                        "code": "TTS_GENERATION_FAILED"
                        if kind == "synthesize"
                        else "TTS_WORKER_PROTOCOL",
                        "message": type(error).__name__,
                        "recoverable": kind == "synthesize",
                    },
                )
        return 0


def main() -> int:
    # The worker never needs a proxy or Hugging Face token after installation.
    for name in tuple(os.environ):
        if name.lower().endswith(("_proxy", "_token")):
            os.environ.pop(name, None)
    return Worker().run()


if __name__ == "__main__":
    raise SystemExit(main())
