import io
import os
import sys
import struct
import json
import torch
import numpy as np
import base64
from pathlib import Path
from safetensors import safe_open
from transformers import WhisperForConditionalGeneration

def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~")+1))+list(range(ord("¡"), ord("¬")+1))+list(range(ord("®"), ord("ÿ")+1))
    cs = bs[:]
    n = 0
    for b in range(2**8):
        if b not in bs:
            bs.append(b)
            cs.append(2**8+n)
            n += 1
    cs = [chr(n) for n in cs]
    return dict(zip(bs, cs))

if len(sys.argv) < 3:
    print("Usage: convert-hf-to-ggml.py model-dir whisper-repo-dir [output-dir] [use-f32]\n")
    print("  model-dir: HuggingFace model directory containing model.safetensors or pytorch_model.bin and config.json")
    print("  whisper-repo-dir: Path to OpenAI whisper repository (for tokenizer and mel filters)")
    print("  output-dir: Optional output directory for ggml-model.bin (defaults to model-dir)")
    print("  use-f32: Optional flag to use float32 instead of float16")
    sys.exit(1)

model_dir = Path(sys.argv[1])
dir_whisper = Path(sys.argv[2])

if len(sys.argv) >= 4 and sys.argv[3] != "use-f32":
    dir_out = Path(sys.argv[3])
else:
    dir_out = model_dir

dir_out.mkdir(parents=True, exist_ok=True)

config_path = model_dir / "config.json"
safetensors_path = model_dir / "model.safetensors"

if not config_path.exists():
    print(f"Error: config.json not found in {model_dir}")
    sys.exit(1)

if not safetensors_path.exists():
    pytorch_path = model_dir / "pytorch_model.bin"
    if pytorch_path.exists():
        print(f"model.safetensors not found, converting from pytorch_model.bin...")
        try:
            model = WhisperForConditionalGeneration.from_pretrained(model_dir)
            model.save_pretrained(model_dir, safe_serialization=True)
            print(f"Successfully converted to safetensors format")
        except Exception as e:
            print(f"Error converting model to safetensors: {e}")
            sys.exit(1)
    else:
        print(f"Error: Neither model.safetensors nor pytorch_model.bin found in {model_dir}")
        sys.exit(1)

with open(config_path, "r") as f:
    config = json.load(f)

hparams = {
    "n_vocab": config["vocab_size"],
    "n_audio_ctx": config["max_source_positions"],
    "n_audio_state": config["d_model"],
    "n_audio_head": config["encoder_attention_heads"],
    "n_audio_layer": config["encoder_layers"],
    "n_text_ctx": config["max_target_positions"],
    "n_text_state": config["d_model"],
    "n_text_head": config["decoder_attention_heads"],
    "n_text_layer": config["decoder_layers"],
    "n_mels": config["num_mel_bins"]
}

print("hparams:", hparams)

print(f"Loading model from {safetensors_path}...")
tensors = {}
with safe_open(safetensors_path, framework="pt", device="cpu") as f:
    for key in f.keys():
        tensors[key] = f.get_tensor(key)

print(f"Loaded {len(tensors)} tensors")

n_mels = hparams["n_mels"]
print(f"Loading mel filters for n_mels={n_mels}")
with np.load(dir_whisper / "whisper" / "assets" / "mel_filters.npz") as f:
    filters = torch.from_numpy(f[f"mel_{n_mels}"])
print(f"Mel filters shape: {filters.shape}")

multilingual = hparams["n_vocab"] >= 51865
print(f"Multilingual: {multilingual} (n_vocab={hparams['n_vocab']})")
tokenizer = dir_whisper / "whisper" / "assets" / (multilingual and "multilingual.tiktoken" or "gpt2.tiktoken")
print(f"Tokenizer path: {tokenizer}")
tokenizer_type = "tiktoken"
if not tokenizer.is_file():
    tokenizer = dir_whisper / "whisper" / "assets" / (multilingual and "multilingual" or "gpt2") / "vocab.json"
    tokenizer_type = "hf_transformers"
    if not tokenizer.is_file():
        print("Error: failed to find either tiktoken or hf_transformers tokenizer file:", tokenizer)
        sys.exit(1)

byte_encoder = bytes_to_unicode()
byte_decoder = {v:k for k, v in byte_encoder.items()}

if tokenizer_type == "tiktoken":
    with open(tokenizer, "rb") as f:
        contents = f.read()
        tokens = {base64.b64decode(token): int(rank) for token, rank in (line.split() for line in contents.splitlines() if line)}
elif tokenizer_type == "hf_transformers":
    with open(tokenizer, "r", encoding="utf8") as f:
        _tokens_raw = json.load(f)
        if '<|endoftext|>' in _tokens_raw:
            del _tokens_raw['<|endoftext|>']
        tokens = {bytes([byte_decoder[c] for c in token]): int(idx) for token, idx in _tokens_raw.items()}

print(f"Loaded {len(tokens)} tokens")

use_f16 = "use-f32" not in sys.argv

if use_f16:
    fname_out = dir_out / "ggml-model.bin"
else:
    fname_out = dir_out / "ggml-model-f32.bin"

fout = fname_out.open("wb")

fout.write(struct.pack("i", 0x67676d6c))
fout.write(struct.pack("i", hparams["n_vocab"]))
fout.write(struct.pack("i", hparams["n_audio_ctx"]))
fout.write(struct.pack("i", hparams["n_audio_state"]))
fout.write(struct.pack("i", hparams["n_audio_head"]))
fout.write(struct.pack("i", hparams["n_audio_layer"]))
fout.write(struct.pack("i", hparams["n_text_ctx"]))
fout.write(struct.pack("i", hparams["n_text_state"]))
fout.write(struct.pack("i", hparams["n_text_head"]))
fout.write(struct.pack("i", hparams["n_text_layer"]))
fout.write(struct.pack("i", hparams["n_mels"]))
fout.write(struct.pack("i", use_f16))

print(f"Writing mel filters: shape {filters.shape[0]} x {filters.shape[1]}")
fout.write(struct.pack("i", filters.shape[0]))
fout.write(struct.pack("i", filters.shape[1]))
for i in range(filters.shape[0]):
    for j in range(filters.shape[1]):
        fout.write(struct.pack("f", filters[i][j]))

print(f"Writing {len(tokens)} tokens")
fout.write(struct.pack("i", len(tokens)))

for key in tokens:
    fout.write(struct.pack("i", len(key)))
    fout.write(key)

name_mapping = {
    "model.encoder.embed_positions.weight": "encoder.positional_embedding",
    "model.encoder.conv1.weight": "encoder.conv1.weight",
    "model.encoder.conv1.bias": "encoder.conv1.bias",
    "model.encoder.conv2.weight": "encoder.conv2.weight",
    "model.encoder.conv2.bias": "encoder.conv2.bias",
    "model.decoder.embed_positions.weight": "decoder.positional_embedding",
    "model.decoder.embed_tokens.weight": "decoder.token_embedding.weight",
    "model.encoder.layer_norm.weight": "encoder.ln_post.weight",
    "model.encoder.layer_norm.bias": "encoder.ln_post.bias",
    "model.decoder.layer_norm.weight": "decoder.ln.weight",
    "model.decoder.layer_norm.bias": "decoder.ln.bias",
}

for i in range(hparams["n_audio_layer"]):
    name_mapping[f"model.encoder.layers.{i}.self_attn.q_proj.weight"] = f"encoder.blocks.{i}.attn.query.weight"
    name_mapping[f"model.encoder.layers.{i}.self_attn.q_proj.bias"] = f"encoder.blocks.{i}.attn.query.bias"
    name_mapping[f"model.encoder.layers.{i}.self_attn.k_proj.weight"] = f"encoder.blocks.{i}.attn.key.weight"
    name_mapping[f"model.encoder.layers.{i}.self_attn.v_proj.weight"] = f"encoder.blocks.{i}.attn.value.weight"
    name_mapping[f"model.encoder.layers.{i}.self_attn.v_proj.bias"] = f"encoder.blocks.{i}.attn.value.bias"
    name_mapping[f"model.encoder.layers.{i}.self_attn.out_proj.weight"] = f"encoder.blocks.{i}.attn.out.weight"
    name_mapping[f"model.encoder.layers.{i}.self_attn.out_proj.bias"] = f"encoder.blocks.{i}.attn.out.bias"
    name_mapping[f"model.encoder.layers.{i}.self_attn_layer_norm.weight"] = f"encoder.blocks.{i}.attn_ln.weight"
    name_mapping[f"model.encoder.layers.{i}.self_attn_layer_norm.bias"] = f"encoder.blocks.{i}.attn_ln.bias"
    name_mapping[f"model.encoder.layers.{i}.fc1.weight"] = f"encoder.blocks.{i}.mlp.0.weight"
    name_mapping[f"model.encoder.layers.{i}.fc1.bias"] = f"encoder.blocks.{i}.mlp.0.bias"
    name_mapping[f"model.encoder.layers.{i}.fc2.weight"] = f"encoder.blocks.{i}.mlp.2.weight"
    name_mapping[f"model.encoder.layers.{i}.fc2.bias"] = f"encoder.blocks.{i}.mlp.2.bias"
    name_mapping[f"model.encoder.layers.{i}.final_layer_norm.weight"] = f"encoder.blocks.{i}.mlp_ln.weight"
    name_mapping[f"model.encoder.layers.{i}.final_layer_norm.bias"] = f"encoder.blocks.{i}.mlp_ln.bias"

for i in range(hparams["n_text_layer"]):
    name_mapping[f"model.decoder.layers.{i}.self_attn.q_proj.weight"] = f"decoder.blocks.{i}.attn.query.weight"
    name_mapping[f"model.decoder.layers.{i}.self_attn.q_proj.bias"] = f"decoder.blocks.{i}.attn.query.bias"
    name_mapping[f"model.decoder.layers.{i}.self_attn.k_proj.weight"] = f"decoder.blocks.{i}.attn.key.weight"
    name_mapping[f"model.decoder.layers.{i}.self_attn.v_proj.weight"] = f"decoder.blocks.{i}.attn.value.weight"
    name_mapping[f"model.decoder.layers.{i}.self_attn.v_proj.bias"] = f"decoder.blocks.{i}.attn.value.bias"
    name_mapping[f"model.decoder.layers.{i}.self_attn.out_proj.weight"] = f"decoder.blocks.{i}.attn.out.weight"
    name_mapping[f"model.decoder.layers.{i}.self_attn.out_proj.bias"] = f"decoder.blocks.{i}.attn.out.bias"
    name_mapping[f"model.decoder.layers.{i}.self_attn_layer_norm.weight"] = f"decoder.blocks.{i}.attn_ln.weight"
    name_mapping[f"model.decoder.layers.{i}.self_attn_layer_norm.bias"] = f"decoder.blocks.{i}.attn_ln.bias"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.q_proj.weight"] = f"decoder.blocks.{i}.cross_attn.query.weight"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.q_proj.bias"] = f"decoder.blocks.{i}.cross_attn.query.bias"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.k_proj.weight"] = f"decoder.blocks.{i}.cross_attn.key.weight"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.v_proj.weight"] = f"decoder.blocks.{i}.cross_attn.value.weight"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.v_proj.bias"] = f"decoder.blocks.{i}.cross_attn.value.bias"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.out_proj.weight"] = f"decoder.blocks.{i}.cross_attn.out.weight"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn.out_proj.bias"] = f"decoder.blocks.{i}.cross_attn.out.bias"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn_layer_norm.weight"] = f"decoder.blocks.{i}.cross_attn_ln.weight"
    name_mapping[f"model.decoder.layers.{i}.encoder_attn_layer_norm.bias"] = f"decoder.blocks.{i}.cross_attn_ln.bias"
    name_mapping[f"model.decoder.layers.{i}.fc1.weight"] = f"decoder.blocks.{i}.mlp.0.weight"
    name_mapping[f"model.decoder.layers.{i}.fc1.bias"] = f"decoder.blocks.{i}.mlp.0.bias"
    name_mapping[f"model.decoder.layers.{i}.fc2.weight"] = f"decoder.blocks.{i}.mlp.2.weight"
    name_mapping[f"model.decoder.layers.{i}.fc2.bias"] = f"decoder.blocks.{i}.mlp.2.bias"
    name_mapping[f"model.decoder.layers.{i}.final_layer_norm.weight"] = f"decoder.blocks.{i}.mlp_ln.weight"
    name_mapping[f"model.decoder.layers.{i}.final_layer_norm.bias"] = f"decoder.blocks.{i}.mlp_ln.bias"

name_mapping["proj_out.weight"] = "decoder.token_embedding.weight"

tensor_count = 0
for hf_name, tensor in tensors.items():
    if hf_name not in name_mapping:
        print(f"Warning: Skipping unmapped tensor: {hf_name}")
        continue
    
    name = name_mapping[hf_name]
    data = tensor.squeeze().float().numpy()
    tensor_count += 1
    print(f"[{tensor_count}] Processing: {name}")
    print(f"    HF name: {hf_name}")
    print(f"    Shape: {data.shape}, dtype: {data.dtype}")
    
    if name in ["encoder.conv1.bias", "encoder.conv2.bias"]:
        data = data.reshape(data.shape[0], 1)
        print(f"    Reshaped to: {data.shape}")
    
    n_dims = len(data.shape)
    
    ftype = 1
    if use_f16:
        if n_dims < 2 or \
                name == "encoder.conv1.bias" or \
                name == "encoder.conv2.bias" or \
                name == "encoder.positional_embedding" or \
                name == "decoder.positional_embedding":
            data = data.astype(np.float32)
            ftype = 0
        else:
            data = data.astype(np.float16)
            ftype = 1
    else:
        data = data.astype(np.float32)
        ftype = 0
    
    str_ = name.encode('utf-8')
    fout.write(struct.pack("iii", n_dims, len(str_), ftype))
    for i in range(n_dims):
        fout.write(struct.pack("i", data.shape[n_dims - 1 - i]))
    fout.write(str_)
    
    data.tofile(fout)
    
print(f"\nTotal tensors written: {tensor_count}")

fout.close()

if tensor_count == 0:
    print("Error: No tensors written")
    sys.exit(1)

print("Done. Output file:", os.path.abspath(fname_out))
print("")


