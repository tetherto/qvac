import base64
import json
import sys
import time

import numpy as np

from . import PROTOCOL_VERSION


class MiniMaxWorker:
    def __init__(self):
        self.pipeline = None

    def load(self, config):
        import torch
        from diffusers import ModularPipeline

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for MiniMax-Music3 Diffusers")
        model_dir = config["modelDir"]
        self.pipeline = ModularPipeline.from_pretrained(model_dir)
        self.pipeline.load_components(dtype=torch.bfloat16)
        self.pipeline.to("cuda")

    def unload(self):
        self.pipeline = None

    def generate(self, request):
        import torch

        if self.pipeline is None:
            raise RuntimeError("MiniMax-Music3 is not loaded")
        max_frames = request["maxFrames"]
        kwargs = {
            "prompt": request["caption"],
            "lyrics": request["lyrics"],
            "audio_duration": max_frames / 25.0,
            "generator": torch.Generator("cuda").manual_seed(request.get("seed", 0)),
            "output": "audios",
        }
        if request.get("inferenceSteps") is not None:
            kwargs["num_inference_steps"] = request["inferenceSteps"]
        if request.get("cfgScale") is not None:
            kwargs["guidance_scale"] = request["cfgScale"]
        audio = np.asarray(self.pipeline(**kwargs)[0])
        pcm = np.clip(audio.T, -1.0, 1.0)
        return (pcm * 32767.0).round().astype("<i2", copy=False).tobytes()


def emit(event):
    sys.stdout.write(json.dumps({"version": PROTOCOL_VERSION, **event}) + "\n")
    sys.stdout.flush()


def error(exc, request_id=None):
    event = {
        "status": "error",
        "error": {"name": type(exc).__name__, "message": str(exc)},
    }
    if request_id is not None:
        event["requestId"] = request_id
    emit(event)


def run_request(worker, request):
    if request.get("version") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    operation = request.get("op")
    if operation == "load":
        worker.load(request["config"])
        emit({"status": "loaded"})
        return
    if operation == "unload":
        worker.unload()
        emit({"status": "unloaded"})
        return
    if operation == "cancel":
        emit({"status": "cancelled", "requestId": request["requestId"]})
        return
    if operation != "generate":
        raise ValueError("unsupported operation")
    request_id = request["requestId"]
    started = time.monotonic()
    emit({"status": "progress", "requestId": request_id, "stage": "ar", "step": 0, "total": request["maxFrames"]})
    pcm = worker.generate(request)
    emit(
        {
            "status": "audio",
            "requestId": request_id,
            "data": base64.b64encode(pcm).decode("ascii"),
            "sampleRate": 44100,
            "channels": 2,
        }
    )
    emit(
        {
            "status": "completed",
            "requestId": request_id,
            "totalTimeMs": round((time.monotonic() - started) * 1000),
        }
    )


def main():
    worker = MiniMaxWorker()
    for line in sys.stdin:
        try:
            run_request(worker, json.loads(line))
        except Exception as exc:
            error(exc)


if __name__ == "__main__":
    main()
