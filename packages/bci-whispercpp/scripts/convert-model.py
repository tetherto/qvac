#!/usr/bin/env python3
"""
Convert BrainWhisperer checkpoint to GGML model + embedder weights for whisper.cpp.

Produces two files required for BCI inference:
  1. GGML model (--output):     whisper encoder/decoder weights, tokenizer, positional
                                embedding, windowed attention params in header
  2. Embedder file (--embedder-output): day projection weights (low-rank A·B per day),
                                        month projections, session-to-day mapping

Both files must be in the same directory at runtime. The C++ addon loads the embedder
from the same directory as the GGML model (looks for "bci-embedder.bin").

Usage:
    python3 scripts/convert-model.py \\
        --checkpoint /path/to/epoch=93-val_wer=0.0910.ckpt \\
        --output models/ggml-bci-windowed.bin \\
        --embedder-output models/bci-embedder.bin
"""

import argparse
import math
import os
import struct

import numpy as np
import torch


def merge_lora_weights(state_dict, alpha=16, r=8):
    scaling = alpha / r
    merged = {}
    lora_pairs = {}

    for key, tensor in state_dict.items():
        if ".lora_A.default.weight" in key:
            base_key = key.replace(".lora_A.default.weight", "")
            lora_pairs.setdefault(base_key, {})["A"] = tensor
        elif ".lora_B.default.weight" in key:
            base_key = key.replace(".lora_B.default.weight", "")
            lora_pairs.setdefault(base_key, {})["B"] = tensor
        elif ".base_layer." in key:
            clean_key = key.replace(".base_layer.", ".")
            merged[clean_key] = tensor.clone()
        else:
            merged[key] = tensor

    for base_key, pair in lora_pairs.items():
        if "A" not in pair or "B" not in pair:
            continue
        A, B = pair["A"], pair["B"]
        delta = (B @ A) * scaling
        weight_key = base_key + ".weight"
        if weight_key in merged:
            merged[weight_key] = merged[weight_key] + delta

    return merged


def build_positional_embedding(state_dict, d_model=384, day_idx=0, sessions=None):
    """Build the combined positional embedding for whisper.cpp.

    The BCI encoder applies two separate positional encodings:
      1. Learned time positions (embed_positions) → first d_model//2 dims
      2. Sinusoidal day encoding (PositionalEncoding) → last d_model//2 dims

    whisper.cpp applies a single encoder.positional_embedding after conv2,
    so we must combine both into one (1500, d_model) tensor.
    """
    half = d_model - d_model // 2  # 192

    pe = np.zeros((1500, d_model), dtype=np.float32)

    # First half: learned time positional encoding from the trained model
    time_pe_key = "model.whisper.model.encoder.embed_positions.weight"
    if time_pe_key in state_dict:
        time_pe = state_dict[time_pe_key].numpy()  # (1500, 192)
        pe[:, :half] = time_pe
        print(f"  Time positional encoding: shape={time_pe.shape}, "
              f"range=[{time_pe.min():.4f}, {time_pe.max():.4f}]")
    else:
        print("  WARNING: embed_positions.weight not found, using zeros for time encoding")

    # Second half: sinusoidal day encoding
    # For day_idx=0 (session index), resolve through SessionsToDays to get day number
    # Default: day_number=0 → PositionalEncoding(192) at position 0 = [sin(0),cos(0),...] = [0,1,0,1,...]
    day_number = day_idx
    if sessions:
        from datetime import datetime
        sorted_sessions = sorted(sessions)
        fmt = "%Y.%m.%d"
        datetimes = [datetime.strptime(s[-10:], fmt) for s in sorted_sessions]
        if day_idx < len(datetimes):
            day_number = (datetimes[day_idx] - datetimes[0]).days

    day_enc = np.zeros(half, dtype=np.float32)
    div_term = np.exp(np.arange(0, half, 2, dtype=np.float32) * (-math.log(10000.0) / half))
    day_enc[0::2] = np.sin(day_number * div_term)
    day_enc[1::2] = np.cos(day_number * div_term)
    pe[:, -half:] = day_enc
    print(f"  Day encoding: day_number={day_number}, "
          f"range=[{day_enc.min():.4f}, {day_enc.max():.4f}]")

    return pe


# Byte encoder/decoder for tokenizer (from whisper.cpp converter)
def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~")+1)) + list(range(ord("¡"), ord("¬")+1)) + list(range(ord("®"), ord("ÿ")+1))
    cs = bs[:]
    n = 0
    for b in range(2**8):
        if b not in bs:
            bs.append(b)
            cs.append(2**8+n)
            n += 1
    cs = [chr(n) for n in cs]
    return dict(zip(bs, cs))


# GGML tensor name mapping (HuggingFace → whisper.cpp)
CONV_MAP = {
    'self_attn.k_proj':              'attn.key',
    'self_attn.q_proj':              'attn.query',
    'self_attn.v_proj':              'attn.value',
    'self_attn.out_proj':            'attn.out',
    'self_attn_layer_norm':          'attn_ln',
    'encoder_attn.q_proj':           'cross_attn.query',
    'encoder_attn.v_proj':           'cross_attn.value',
    'encoder_attn.out_proj':         'cross_attn.out',
    'encoder_attn_layer_norm':       'cross_attn_ln',
    'fc1':                           'mlp.0',
    'fc2':                           'mlp.2',
    'final_layer_norm':              'mlp_ln',
}


def rename_key(hf_key):
    """Convert HuggingFace key to whisper.cpp GGML key."""
    parts = hf_key.split(".")
    if len(parts) < 2:
        return hf_key

    section = parts[0]  # encoder or decoder
    rest = parts[1:]

    if rest[0] == "layers":
        rest[0] = "blocks"
        layer_idx = rest[1]
        inner = ".".join(rest[2:-1])

        if inner == "encoder_attn.k_proj":
            mapped = "cross_attn.key"
        elif inner in CONV_MAP:
            mapped = CONV_MAP[inner]
        else:
            mapped = inner

        return f"{section}.blocks.{layer_idx}.{mapped}.{rest[-1]}"
    else:
        simple_map = {
            "layer_norm.bias": f"{section}.ln_post.bias" if section == "encoder" else f"{section}.ln.bias",
            "layer_norm.weight": f"{section}.ln_post.weight" if section == "encoder" else f"{section}.ln.weight",
            "embed_positions.weight": f"{section}.positional_embedding",
            "embed_tokens.weight": f"{section}.token_embedding.weight",
        }
        rest_str = ".".join(rest)
        if rest_str in simple_map:
            return simple_map[rest_str]
        return f"{section}.{rest_str}"


def export_embedder(state_dict, output_path):
    """Export day projection / embedder weights to a binary file.

    The C++ NeuralProcessor loads this file to apply day-specific
    projection (low-rank A·B + month + softsign) before whisper inference.
    Without it, raw smoothed signals are passed directly — producing garbage.
    """
    conv1_w = state_dict['model.embedders.0.conv1.weight'].numpy().flatten()
    conv1_b = state_dict['model.embedders.0.conv1.bias'].numpy().flatten()
    conv2_w = state_dict['model.embedders.0.conv2.weight'].numpy().flatten()
    conv2_b = state_dict['model.embedders.0.conv2.bias'].numpy().flatten()

    embed_dim = int(state_dict['model.embedders.0.conv1.weight'].shape[0])
    num_features = int(state_dict['model.embedders.0.conv1.weight'].shape[1])
    kernel_size1 = int(state_dict['model.embedders.0.conv1.weight'].shape[2])
    kernel_size2 = int(state_dict['model.embedders.0.conv2.weight'].shape[2])

    day_a_keys = sorted(
        [k for k in state_dict if k.startswith('model.embedders.0.day_As.')],
        key=lambda k: int(k.split('.')[-1]))
    day_b_keys = sorted(
        [k for k in state_dict if k.startswith('model.embedders.0.day_Bs.')],
        key=lambda k: int(k.split('.')[-1]))
    day_bias_keys = sorted(
        [k for k in state_dict if k.startswith('model.embedders.0.day_biases.')],
        key=lambda k: int(k.split('.')[-1]))
    month_w_keys = sorted(
        [k for k in state_dict if k.startswith('model.embedders.0.month_weights.')],
        key=lambda k: int(k.split('.')[-1]))
    month_b_keys = sorted(
        [k for k in state_dict if k.startswith('model.embedders.0.month_biases.')],
        key=lambda k: int(k.split('.')[-1]))

    num_days = len(day_a_keys)
    num_months = len(month_w_keys)
    r = int(state_dict[day_a_keys[0]].shape[1]) if day_a_keys else 0

    s2d = state_dict.get('model.embedders.0.sessions_to_days.session_to_idx_map')

    EMBEDDER_MAGIC = 0x42434945
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(struct.pack('I', EMBEDDER_MAGIC))
        f.write(struct.pack('I', 1))              # version
        f.write(struct.pack('I', num_features))
        f.write(struct.pack('I', embed_dim))
        f.write(struct.pack('I', kernel_size1))
        f.write(struct.pack('I', kernel_size2))
        f.write(struct.pack('I', 2))              # stride2
        f.write(struct.pack('I', num_days))
        f.write(struct.pack('I', num_months))
        f.write(struct.pack('I', r))

        for arr in [conv1_w, conv1_b, conv2_w, conv2_b]:
            f.write(struct.pack('I', len(arr)))
            f.write(arr.astype(np.float32).tobytes())

        if s2d is not None:
            s2d_np = s2d.numpy().astype(np.int32).flatten()
            f.write(struct.pack('I', len(s2d_np)))
            f.write(s2d_np.tobytes())
        else:
            f.write(struct.pack('I', 0))

        for i in range(num_days):
            for keys in [day_a_keys, day_b_keys, day_bias_keys]:
                data = state_dict[keys[i]].numpy().flatten().astype(np.float32)
                f.write(struct.pack('I', len(data)))
                f.write(data.tobytes())

        for i in range(num_months):
            for keys in [month_w_keys, month_b_keys]:
                data = state_dict[keys[i]].numpy().flatten().astype(np.float32)
                f.write(struct.pack('I', len(data)))
                f.write(data.tobytes())

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  Embedder: {output_path} ({size_mb:.1f} MB)")
    print(f"  {num_days} days, {num_months} months, rank={r}, "
          f"features={num_features}")


def main():
    parser = argparse.ArgumentParser(
        description="Convert BrainWhisperer checkpoint to GGML model + embedder")
    parser.add_argument("--checkpoint", required=True,
                        help="Path to BrainWhisperer .ckpt file")
    parser.add_argument("--output", default="models/ggml-bci-windowed.bin",
                        help="Output path for GGML model (default: models/ggml-bci-windowed.bin)")
    parser.add_argument("--embedder-output", default="models/bci-embedder.bin",
                        help="Output path for embedder weights (default: models/bci-embedder.bin)")
    parser.add_argument("--f32", action="store_true",
                        help="Use f32 for all tensors (avoids f16 precision loss)")
    parser.add_argument("--day-idx", type=int, default=1,
                        help="Day index for baked positional embedding (default: 1)")
    parser.add_argument("--window-size", type=int, default=57,
                        help="Windowed attention size, 0 to disable (default: 57)")
    parser.add_argument("--last-window-layer", type=int, default=3,
                        help="Last encoder layer with windowed attention (default: 3)")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    # Load checkpoint
    print(f"Loading checkpoint: {args.checkpoint}")
    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state_dict = ckpt["state_dict"]
    config = ckpt["hyper_parameters"]["config"]

    # Merge LoRA
    print("Merging LoRA weights...")
    merged = merge_lora_weights(state_dict, alpha=16, r=8)

    # Build the model state dict for GGML
    # We need: encoder (conv1/conv2 from embedder, layers 0-5 from encoder, layer_norm)
    #          decoder (LoRA-merged layers 0-3, embed_tokens, embed_positions, layer_norm)
    #          proj_out

    model_sd = {}

    # --- Encoder conv1 from EMBEDDER (k=7, 512->384) — patched whisper.cpp supports this ---
    model_sd["encoder.conv1.weight"] = merged["model.embedders.0.conv1.weight"]  # (384, 512, 7)
    model_sd["encoder.conv1.bias"] = merged["model.embedders.0.conv1.bias"]      # (384,)

    # --- Encoder conv2 from EMBEDDER (k=3, stride=2) ---
    model_sd["encoder.conv2.weight"] = merged["model.embedders.0.conv2.weight"]  # (384, 384, 3)
    model_sd["encoder.conv2.bias"] = merged["model.embedders.0.conv2.bias"]      # (384,)

    # --- Encoder positional embedding (combined time + day encoding) ---
    # Extract sessions list from checkpoint config for day number resolution
    sessions = config.get("dataset", {}).get("sessions", None)
    if sessions is None:
        sessions = config.get("sessions", None)
    print("Building combined positional embedding...")
    model_sd["encoder.positional_embedding"] = torch.from_numpy(
        build_positional_embedding(merged, d_model=384, day_idx=args.day_idx, sessions=sessions))

    # --- Encoder transformer layers 0-5 ---
    for layer_idx in range(6):
        prefix_src = f"model.whisper.model.encoder.layers.{layer_idx}."
        for key, tensor in merged.items():
            if key.startswith(prefix_src):
                suffix = key[len("model.whisper.model.encoder."):]
                ggml_name = rename_key(f"encoder.{suffix}")
                model_sd[ggml_name] = tensor

    # --- Encoder layer norm ---
    model_sd["encoder.ln_post.weight"] = merged["model.whisper.model.encoder.layer_norm.weight"]
    model_sd["encoder.ln_post.bias"] = merged["model.whisper.model.encoder.layer_norm.bias"]

    # --- Decoder (LoRA-merged) ---
    dec_prefix = "model.whisper.model.decoder."
    for key, tensor in merged.items():
        if not key.startswith(dec_prefix):
            continue
        # Remove PEFT wrapper
        clean = key[len("model.whisper.model."):]
        clean = clean.replace("decoder.base_model.model.", "decoder.")
        ggml_name = rename_key(clean)
        model_sd[ggml_name] = tensor

    # --- proj_out ---
    if "model.whisper.proj_out.weight" in merged:
        # whisper.cpp skips proj_out (uses decoder.token_embedding transposed)
        pass

    # Model hyperparameters
    d_model = 384
    n_audio_head = 6
    n_audio_layer = 6
    n_text_head = 6
    n_text_layer = 4
    n_mels = 512  # neural signal channels (conv1 k=7 in patched whisper.cpp)
    n_conv1_kernel = 7
    n_vocab = 51864
    n_audio_ctx = 1500
    n_text_ctx = 448

    print(f"\nGGML model: n_mels={n_mels}, encoder_layers={n_audio_layer}, "
          f"decoder_layers={n_text_layer}, d_model={d_model}")
    print(f"Tensors to write: {len(model_sd)}")

    # Mel filters: must have n_mel rows matching the header n_mels value,
    # because whisper_set_mel_with_state validates n_mel == filters.n_mel.
    mel_filters = np.zeros((n_mels, 201), dtype=np.float32)

    # Load tokenizer
    from transformers import WhisperTokenizer
    tokenizer = WhisperTokenizer.from_pretrained("openai/whisper-tiny.en")
    tokens_dict = tokenizer.get_vocab()
    tokens_sorted = sorted(tokens_dict.items(), key=lambda x: x[1])

    byte_decoder = {v: k for k, v in bytes_to_unicode().items()}

    # Write GGML file
    print(f"\nWriting GGML model to: {args.output}")
    with open(args.output, "wb") as fout:
        # Magic
        fout.write(struct.pack("i", 0x67676d6c))

        # Header (matches whisper.cpp expected order)
        fout.write(struct.pack("i", n_vocab))
        fout.write(struct.pack("i", n_audio_ctx))
        fout.write(struct.pack("i", d_model))
        fout.write(struct.pack("i", n_audio_head))
        fout.write(struct.pack("i", n_audio_layer))
        fout.write(struct.pack("i", n_text_ctx))
        fout.write(struct.pack("i", d_model))
        fout.write(struct.pack("i", n_text_head))
        fout.write(struct.pack("i", n_text_layer))
        fout.write(struct.pack("i", n_mels))
        ftype_global = 0 if args.f32 else 1
        fout.write(struct.pack("i", ftype_global))  # ftype: 0=f32, 1=f16
        fout.write(struct.pack("i", n_conv1_kernel))  # BCI extension
        fout.write(struct.pack("i", args.window_size))  # BCI windowed attention
        fout.write(struct.pack("i", args.last_window_layer))

        # Mel filters (n_mels x 201, must match n_mels for whisper_set_mel validation)
        fout.write(struct.pack("i", mel_filters.shape[0]))
        fout.write(struct.pack("i", mel_filters.shape[1]))
        for i in range(mel_filters.shape[0]):
            for j in range(mel_filters.shape[1]):
                fout.write(struct.pack("f", mel_filters[i][j]))

        # Tokenizer
        fout.write(struct.pack("i", len(tokens_sorted)))
        for token_str, token_id in tokens_sorted:
            try:
                text = bytearray([byte_decoder[c] for c in token_str])
            except KeyError:
                text = token_str.encode("utf-8")
            fout.write(struct.pack("i", len(text)))
            fout.write(text)

        # Write tensors
        for name, tensor in model_sd.items():
            data = tensor.squeeze().numpy()

            # Reshape conv bias from [n] to [n, 1]
            if name in ["encoder.conv1.bias", "encoder.conv2.bias"]:
                data = data.reshape(data.shape[0], 1)

            n_dims = len(data.shape)

            use_f16 = not args.f32
            ftype = 1 if use_f16 else 0
            if n_dims < 2 or \
                    name == "encoder.conv1.bias" or \
                    name == "encoder.conv2.bias" or \
                    name == "encoder.positional_embedding" or \
                    name == "decoder.positional_embedding":
                use_f16 = False
                ftype = 0

            if use_f16:
                data = data.astype(np.float16)
            else:
                data = data.astype(np.float32)

            # Tensor header: n_dims, name_len, ftype
            name_bytes = name.encode("utf-8")
            fout.write(struct.pack("iii", n_dims, len(name_bytes), ftype))

            # Dims (reversed from numpy, as GGML expects)
            for i in range(n_dims):
                fout.write(struct.pack("i", data.shape[n_dims - 1 - i]))

            fout.write(name_bytes)
            data.tofile(fout)

            print(f"  {name}: {data.shape} ({'f16' if ftype == 1 else 'f32'})")

    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"  GGML model: {args.output} ({size_mb:.1f} MB)")

    # --- Export embedder weights ---
    print(f"\nWriting embedder weights to: {args.embedder_output}")
    export_embedder(state_dict, args.embedder_output)

    print(f"\nDone. Both files are required for inference:")
    print(f"  {args.output}")
    print(f"  {args.embedder_output}")


if __name__ == "__main__":
    main()
