# @qvac/audiogen-diffusers

Desktop CUDA bridge for the official MiniMax-Music3 Diffusers pipeline.

The package launches a local Python worker over newline-delimited JSON. It does not bundle Python, PyTorch, CUDA libraries, or MiniMax weights.

## Requirements

- Linux or Windows desktop with an NVIDIA CUDA GPU
- Python 3.10 or newer
- A local snapshot of `MiniMaxAI/MiniMax-Music3`
- The Python worker installed from `python/`

```sh
python -m pip install ./python
hf download MiniMaxAI/MiniMax-Music3 --local-dir /absolute/path/to/minimax-music3
```

The worker requires `torch.cuda.is_available()` and loads the model in BF16.

## Protocol

Start the worker with:

```sh
python -m qvac_audiogen_diffusers
```

Send `load`, `generate`, and `unload` JSON objects, one per line. The worker returns JSON events on standard output. Audio events contain interleaved signed 16-bit stereo PCM at 44.1 kHz, base64 encoded.

The initial worker provides lifecycle and generation protocol support. In-flight cancellation must be connected to the Diffusers execution callback before this package is exposed through the QVAC inference plugin.
