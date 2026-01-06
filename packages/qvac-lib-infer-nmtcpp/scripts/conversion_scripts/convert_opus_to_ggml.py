#!/usr/bin/env python3
"""
Convert Hugging Face Marian models to GGML format for whisper.cpp.
Simplified version that follows whisper.cpp's exact expectations.
"""

import argparse
import json
import struct
import sys
from pathlib import Path
import re

import numpy as np
import torch
from transformers import MarianConfig, MarianTokenizer
import sentencepiece as spm
from huggingface_hub import snapshot_download


def load_marian_model(model_path: Path):
    """Load Marian model from directory."""
    config_path = model_path / "config.json"
    with open(config_path, 'r') as f:
        config_dict = json.load(f)
    
    config = MarianConfig.from_dict(config_dict)
    tokenizer = MarianTokenizer.from_pretrained(model_path)
    
    model_file = model_path / "pytorch_model.bin"
    if not model_file.exists():
        raise FileNotFoundError(f"Model file not found: {model_file}")
    
    state_dict = torch.load(model_file, map_location='cpu')
    
    return config, tokenizer, state_dict


def write_header(fout, config, quant_type: str = "f16"):
    """Write GGML header matching loader expectations (MODEL_MARIAN + quant type)."""
    # Magic number: "ggml" in hex
    fout.write(struct.pack("i", 0x67676d6c))
    
    fout.write(struct.pack("i", config.vocab_size))
    fout.write(struct.pack("i", config.max_position_embeddings))
    fout.write(struct.pack("i", config.d_model))
    fout.write(struct.pack("i", config.encoder_attention_heads))
    fout.write(struct.pack("i", config.encoder_layers))
    fout.write(struct.pack("i", config.max_position_embeddings))
    fout.write(struct.pack("i", config.d_model))
    fout.write(struct.pack("i", config.decoder_attention_heads))
    fout.write(struct.pack("i", config.decoder_layers))


    fout.write(struct.pack("i", 2))

    activation_func_map = {"relu" : 0 ,"swish" : 1}
    fout.write(struct.pack("i", activation_func_map.get(config.activation_function, 1)))

    # ftype / quantization kind (0=f32,1=f16,2=q4_0)
    quant_type_map = {"f32": 0, "f16": 1, "q4_0": 2}
    fout.write(struct.pack("i", quant_type_map.get(quant_type, 1)))

    fout.write(struct.pack("i", getattr(config, 'encoder_ffn_dim', 2048)))           # encoder_ffn_dim
    fout.write(struct.pack("i", getattr(config, 'decoder_ffn_dim', 2048)))           # decoder_ffn_dim

    print(f"Marian config written:")
    print(f"  encoder_ffn_dim: {getattr(config, 'encoder_ffn_dim', 2048)}")
    print(f"  decoder_ffn_dim: {getattr(config, 'decoder_ffn_dim', 2048)}")

def write_vocabulary(fout, vocab):
    """Write vocabulary in GGML format."""
    tokens = [""] * len(vocab)
    for token, token_id in vocab.items():
        tokens[token_id] = token
    
    fout.write(struct.pack("i", len(tokens)))
    
    for token in tokens:
        token_bytes = token.encode('utf-8')
        fout.write(struct.pack("i", len(token_bytes)))
        fout.write(token_bytes)


def quantize_q4_0(data: np.ndarray):
    """Quantize tensor to GGML Q4_0 format (4-bit blocks of 32 values)."""
    original_shape = data.shape
    flat_data = data.flatten().astype(np.float32)
    
    # Q4_0 uses blocks of 32 values
    block_size = 32
    n_blocks = (len(flat_data) + block_size - 1) // block_size
    
    # Pad data to be divisible by block_size
    padded_size = n_blocks * block_size
    if len(flat_data) < padded_size:
        padded_data = np.zeros(padded_size, dtype=np.float32)
        padded_data[:len(flat_data)] = flat_data
        flat_data = padded_data
    
    # Reshape into blocks for vectorized processing
    blocks = flat_data.reshape(n_blocks, block_size)
    
    # Find absolute max and corresponding max value for each block (vectorized)
    abs_blocks = np.abs(blocks)
    max_indices = np.argmax(abs_blocks, axis=1)
    max_vals = blocks[np.arange(n_blocks), max_indices]
    
    # Calculate scale factors: d = max / -8 (vectorized)
    scales = np.where(max_vals != 0, max_vals / -8.0, 0.0)
    id_vals = np.where(scales != 0, 1.0 / scales, 0.0)
    
    # Expand id_vals for broadcasting
    id_vals_expanded = id_vals[:, np.newaxis]
    
    # Quantize all blocks at once
    quantized_values = blocks * id_vals_expanded + 8.5
    quantized_values = np.clip(quantized_values, 0, 15).astype(np.uint8)
    
    # Split each block into first half (lower nibbles) and second half (upper nibbles)
    first_half = quantized_values[:, :16]  # indices 0-15
    second_half = quantized_values[:, 16:32]  # indices 16-31
    
    # Pack nibbles: lower nibble = first_half, upper nibble = second_half
    packed_data = first_half | (second_half << 4)
    
    # Convert to final format
    scales_array = scales.astype(np.float16)
    quantized_data = packed_data.flatten()
    
    return scales_array, quantized_data, original_shape, n_blocks


def write_tensor_header(fout, name: str, shape: tuple, ftype: int):
    n_dims = len(shape)
    name_bytes = name.encode('utf-8')
    fout.write(struct.pack("iii", n_dims, len(name_bytes), ftype))
    for i in range(n_dims):
        fout.write(struct.pack("i", shape[n_dims - 1 - i]))
    fout.write(name_bytes)


def should_quantize_tensor(name: str, data: np.ndarray) -> bool:
    n_dims = len(data.shape)
    if n_dims < 2:
        return False
    if "bias" in name:
        return False
    if "layer_norm" in name or "layernorm" in name:
        return False
    # Avoid quantizing positional embeddings for Marian
    if name == "encoder.embed_positions.weight" or name == "decoder.embed_positions.weight":
        return False
    return True


def write_tensor(fout, name: str, data: np.ndarray, quant_type: str = "f16"):
    """Write a single tensor in GGML format (f32/f16/q4_0)."""
    if quant_type == "q4_0" and should_quantize_tensor(name, data):
        scales, quantized_data, _, n_blocks = quantize_q4_0(data)
        ftype = 2
        ftype_string = "q4_0"
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string}, blocks={n_blocks})")
        write_tensor_header(fout, name, data.shape, ftype)
        scale_bytes = np.frombuffer(scales.tobytes(), dtype=np.uint8).reshape(n_blocks, 2)
        quantized_reshaped = quantized_data.reshape(n_blocks, 16)
        interleaved = np.concatenate([scale_bytes, quantized_reshaped], axis=1)
        interleaved.tofile(fout)
    elif quant_type == "f16" and should_quantize_tensor(name, data):
        data = data.astype(np.float16)
        ftype = 1
        ftype_string = "f16"
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string})")
        write_tensor_header(fout, name, data.shape, ftype)
        data.tofile(fout)
    else:
        data = data.astype(np.float32)
        ftype = 0
        ftype_string = "f32"
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string})")
        write_tensor_header(fout, name, data.shape, ftype)
        data.tofile(fout)


def get_tensor_name_mapping():
    """Map Marian tensor names to whisper.cpp expected names."""
    return {
        # Embeddings
        "model.shared.weight": "encoder.embeddings.weight",
        "model.encoder.embed_tokens.weight": "encoder.embeddings.weight",
        "model.decoder.embed_tokens.weight": "decoder.embeddings.weight",
        "model.encoder.embed_positions.weight": "encoder.embed_positions.weight", 
        "model.decoder.embed_positions.weight": "decoder.embed_positions.weight",
        
        # Layer norms
        "model.encoder.layernorm_embedding.weight": "encoder.layer_norm.weight",
        "model.encoder.layernorm_embedding.bias": "encoder.layer_norm.bias",
        "model.decoder.layernorm_embedding.weight": "decoder.layer_norm.weight", 
        "model.decoder.layernorm_embedding.bias": "decoder.layer_norm.bias",
        
        # Final logits bias
        "final_logits_bias": "final_logits_bias",
        
        # Encoder layers
        "model.encoder.layers.{}.self_attn_layer_norm.weight": "encoder.layers.{}.self_attn_layer_norm.weight",
        "model.encoder.layers.{}.self_attn_layer_norm.bias": "encoder.layers.{}.self_attn_layer_norm.bias",
        "model.encoder.layers.{}.self_attn.q_proj.weight": "encoder.layers.{}.self_attn.q_proj.weight",
        "model.encoder.layers.{}.self_attn.q_proj.bias": "encoder.layers.{}.self_attn.q_proj.bias", 
        "model.encoder.layers.{}.self_attn.k_proj.weight": "encoder.layers.{}.self_attn.k_proj.weight",
        "model.encoder.layers.{}.self_attn.k_proj.bias": "encoder.layers.{}.self_attn.k_proj.bias",
        "model.encoder.layers.{}.self_attn.v_proj.weight": "encoder.layers.{}.self_attn.v_proj.weight",
        "model.encoder.layers.{}.self_attn.v_proj.bias": "encoder.layers.{}.self_attn.v_proj.bias",
        "model.encoder.layers.{}.self_attn.out_proj.weight": "encoder.layers.{}.self_attn.out_proj.weight",
        "model.encoder.layers.{}.self_attn.out_proj.bias": "encoder.layers.{}.self_attn.out_proj.bias",
        "model.encoder.layers.{}.final_layer_norm.weight": "encoder.layers.{}.final_layer_norm.weight",
        "model.encoder.layers.{}.final_layer_norm.bias": "encoder.layers.{}.final_layer_norm.bias",
        "model.encoder.layers.{}.fc1.weight": "encoder.layers.{}.fc1.weight",
        "model.encoder.layers.{}.fc1.bias": "encoder.layers.{}.fc1.bias",
        "model.encoder.layers.{}.fc2.weight": "encoder.layers.{}.fc2.weight",
        "model.encoder.layers.{}.fc2.bias": "encoder.layers.{}.fc2.bias",
        
        # Decoder layers
        "model.decoder.layers.{}.self_attn_layer_norm.weight": "decoder.blocks.{}.attn_ln.weight",
        "model.decoder.layers.{}.self_attn_layer_norm.bias": "decoder.blocks.{}.attn_ln.bias",
        "model.decoder.layers.{}.self_attn.q_proj.weight": "decoder.blocks.{}.attn.query.weight",
        "model.decoder.layers.{}.self_attn.q_proj.bias": "decoder.blocks.{}.attn.query.bias",
        "model.decoder.layers.{}.self_attn.k_proj.weight": "decoder.blocks.{}.attn.key.weight",
        "model.decoder.layers.{}.self_attn.k_proj.bias": "decoder.blocks.{}.attn.key.bias",
        "model.decoder.layers.{}.self_attn.v_proj.weight": "decoder.blocks.{}.attn.value.weight",
        "model.decoder.layers.{}.self_attn.v_proj.bias": "decoder.blocks.{}.attn.value.bias",
        "model.decoder.layers.{}.self_attn.out_proj.weight": "decoder.blocks.{}.attn.out.weight",
        "model.decoder.layers.{}.self_attn.out_proj.bias": "decoder.blocks.{}.attn.out.bias",
        
        # Cross-attention components
        "model.decoder.layers.{}.encoder_attn_layer_norm.weight": "decoder.blocks.{}.cross_attn_ln.weight",
        "model.decoder.layers.{}.encoder_attn_layer_norm.bias": "decoder.blocks.{}.cross_attn_ln.bias",
        "model.decoder.layers.{}.encoder_attn.q_proj.weight": "decoder.blocks.{}.cross_attn.query.weight",
        "model.decoder.layers.{}.encoder_attn.q_proj.bias": "decoder.blocks.{}.cross_attn.query.bias",
        "model.decoder.layers.{}.encoder_attn.k_proj.weight": "decoder.blocks.{}.cross_attn.key.weight",
        "model.decoder.layers.{}.encoder_attn.k_proj.bias": "decoder.blocks.{}.cross_attn.key.bias",
        "model.decoder.layers.{}.encoder_attn.v_proj.weight": "decoder.blocks.{}.cross_attn.value.weight",
        "model.decoder.layers.{}.encoder_attn.v_proj.bias": "decoder.blocks.{}.cross_attn.value.bias",
        "model.decoder.layers.{}.encoder_attn.out_proj.weight": "decoder.blocks.{}.cross_attn.out.weight",
        "model.decoder.layers.{}.encoder_attn.out_proj.bias": "decoder.blocks.{}.cross_attn.out.bias",
        
        # MLP components
        "model.decoder.layers.{}.final_layer_norm.weight": "decoder.blocks.{}.mlp_ln.weight",
        "model.decoder.layers.{}.final_layer_norm.bias": "decoder.blocks.{}.mlp_ln.bias",
        "model.decoder.layers.{}.fc1.weight": "decoder.blocks.{}.mlp.0.weight",
        "model.decoder.layers.{}.fc1.bias": "decoder.blocks.{}.mlp.0.bias",
        "model.decoder.layers.{}.fc2.weight": "decoder.blocks.{}.mlp.2.weight",
        "model.decoder.layers.{}.fc2.bias": "decoder.blocks.{}.mlp.2.bias",
    }


def convert_tensor_name(original_name: str) -> str:
    """Convert Marian tensor name to whisper.cpp expected name."""
    name_mapping = get_tensor_name_mapping()
    
    for pattern, replacement in name_mapping.items():
        if "{}" in pattern:
            import re
            pattern_regex = pattern.replace("{}", r"(\d+)")
            match = re.match(pattern_regex, original_name)
            if match:
                layer_num = match.group(1)
                return replacement.format(layer_num)
        elif pattern == original_name:
            return replacement
    
    return original_name


def convert_marian_to_ggml(model_path: Path, output_path: Path, quant_type: str = "f16"):
    """Convert Marian model to GGML format with optional quantization."""
    print(f"Loading Marian model from {model_path}")
    config, tokenizer, state_dict = load_marian_model(model_path)
    
    print(f"Model config: {config}")
    print(f"Vocabulary size: {len(tokenizer.get_vocab())}")
    print(f"Total tensors: {len(state_dict)}")
    print(f"Using quantization: {quant_type}")
    
    encode_vocab = tokenizer.get_vocab()
    vocab_tokens = [""] * len(encode_vocab)
    for token, idx in encode_vocab.items():
        vocab_tokens[idx] = token
    
    print(f"Vocabulary size: {len(vocab_tokens)}")
    
    try:
        serialized_sp_model = tokenizer.spm_source.serialized_model_proto()
        serialized_target_sp_model = tokenizer.spm_target.serialized_model_proto()
        print(f"Extracted original SentencePiece model: {len(serialized_sp_model)} bytes")
    except Exception as e:
        print(f"Warning: Could not extract SentencePiece model: {e}")
        print("Creating empty SentencePiece model data...")
        serialized_sp_model = b""
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'wb') as fout:
        print("Writing header...")
        write_header(fout, config, quant_type)
        
        print("Writing vocabulary...")
        encode_vocab = tokenizer.get_src_vocab()
        write_vocabulary(fout, encode_vocab)

        # Write bad word ids from config.bad_words_config (no fallbacks)
        bad_word_ids = getattr(config, 'bad_words_ids', [])

        # Flatten nested lists (common format in HF configs)
        flat_bad_word_ids = [token_id for sublist in bad_word_ids for token_id in (sublist if isinstance(sublist, (list, tuple)) else [sublist])]

        # Write the count followed by the ids themselves
        fout.write(struct.pack("i", len(flat_bad_word_ids)))
        for token_id in flat_bad_word_ids:
            fout.write(struct.pack("i", token_id))

        fout.write(struct.pack("i", len(serialized_sp_model)))

        if len(serialized_sp_model) > 0:
            fout.write(serialized_sp_model)
        
        fout.write(struct.pack("i", len(serialized_target_sp_model)))

        if len(serialized_target_sp_model) > 0:
            fout.write(serialized_target_sp_model)
 
        print(f"Converting {len(state_dict)} tensors...")
        shared_tensor = None
        
        for name, tensor in state_dict.items():
            if name == "model.shared.weight":
                shared_tensor = tensor.clone()
            
            if (name == "model.encoder.embed_tokens.weight" and "model.shared.weight" in state_dict) or (name == "lm_head.weight" and "model.shared.weight" in state_dict):
            # if (name == "model.encoder.embed_tokens.weight" and "model.shared.weight" in state_dict):
                if torch.equal(tensor, state_dict["model.shared.weight"]):
                    print(f"Skipping duplicate tensor: {name} (same as shared)")
                    continue
            
            ggml_name = convert_tensor_name(name)
            
            if tensor.dtype == torch.float16:
                np_tensor = tensor.to(torch.float32).numpy()
            else:
                np_tensor = tensor.numpy()
            
            write_tensor(fout, ggml_name, np_tensor, quant_type)
        
        if shared_tensor is not None:
            print("Adding lm_head.weight from shared embeddings")
            if shared_tensor.dtype == torch.float16:
                np_tensor = shared_tensor.to(torch.float32).numpy()
            else:
                np_tensor = shared_tensor.numpy()
            write_tensor(fout, "lm_head.weight", np_tensor, quant_type)
    
    print(f"Conversion complete! GGML file saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Convert Marian model to GGML format")
    parser.add_argument("--model-dir", type=str,
                        help="Path to Marian model directory")
    parser.add_argument("--output", type=str, default="ggml-opus-en-it.bin",
                        help="Output GGML file path")
    parser.add_argument("--quant", type=str, default="f16", choices=["f32", "f16", "q4_0"],
                        help="Quantization type: f32, f16, or q4_0 (default: f16)")
    
    
    args = parser.parse_args()
    
    model_path = Path(args.model_dir)
    output_path = Path(args.output)
    quant_type = args.quant
    
    if not model_path.exists():
        print(f"Model path {model_path} not found locally; treating as Hugging Face repo id")
        repo_id = args.model_dir.strip()
        if not re.match(r"^Helsinki-NLP/opus-.*$", repo_id):
            print(f"Error: Unsupported repo id '{repo_id}'. Expected 'Helsinki-NLP/opus-mt*'.")
            return -1

        snapshot_download(repo_id, token=None, local_dir=repo_id)
        model_path = Path(repo_id)

    
    try:
        convert_marian_to_ggml(model_path, output_path, quant_type)
        return 0
    except Exception as e:
        print(f"Error during conversion: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main()) 
