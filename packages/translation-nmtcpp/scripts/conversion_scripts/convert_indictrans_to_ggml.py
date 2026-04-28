#!/usr/bin/env python3
"""
Convert Hugging Face IndicTrans2 models to GGML format for whisper.cpp.
Based on convert_opus_to_ggml.py but adapted for IndicTrans2 models.
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer, AutoConfig


def extract_indictrans_dual_sentencepiece_models(tokenizer):
    """
    Extract both source and target SentencePiece models for IndicTrans2 tokenizer.
    Returns (src_model, tgt_model, src_vocab_size, tgt_vocab_size).
    """
    src_model = b""
    tgt_model = b""
    src_vocab_size = 0
    tgt_vocab_size = 0
    
    if hasattr(tokenizer, 'src_spm') and tokenizer.src_spm is not None:
        src_model = tokenizer.src_spm.serialized_model_proto()
        src_vocab_size = tokenizer.src_vocab_size
        print(f"Extracted IndicTrans2 source SentencePiece model: {len(src_model)} bytes, vocab_size: {src_vocab_size}")
        
    if hasattr(tokenizer, 'tgt_spm') and tokenizer.tgt_spm is not None:
        tgt_model = tokenizer.tgt_spm.serialized_model_proto()
        tgt_vocab_size = tokenizer.tgt_vocab_size
        print(f"Extracted IndicTrans2 target SentencePiece model: {len(tgt_model)} bytes, vocab_size: {tgt_vocab_size}")
        
    if len(src_model) == 0 or len(tgt_model) == 0:
        raise RuntimeError("Could not extract both source and target SentencePiece models for IndicTrans2 tokenizer")
        
    return src_model, tgt_model, src_vocab_size, tgt_vocab_size


def extract_sentencepiece_model(tokenizer):
    """
    Comprehensive SentencePiece model extraction for IndicTrans2 tokenizer.
    IndicTrans2 has separate source and target SentencePiece models.
    """
    serialized_sp_model = b""
    extraction_method = "none"
    
    try:
        # Method 1: IndicTrans2 specific - extract source SentencePiece model
        if hasattr(tokenizer, 'src_spm') and tokenizer.src_spm is not None:
            serialized_sp_model = tokenizer.src_spm.serialized_model_proto()
            extraction_method = "indictrans_src_spm"
            print(f"✓ Extracted IndicTrans2 source SentencePiece model: {len(serialized_sp_model)} bytes")
            
        # Method 2: Try reading source SentencePiece model file directly
        elif hasattr(tokenizer, 'src_spm_fp') and tokenizer.src_spm_fp:
            import os
            if os.path.exists(tokenizer.src_spm_fp):
                with open(tokenizer.src_spm_fp, 'rb') as f:
                    serialized_sp_model = f.read()
                extraction_method = f"indictrans_src_file: {tokenizer.src_spm_fp}"
                print(f"✓ Extracted from IndicTrans2 source file: {len(serialized_sp_model)} bytes")
                
        # Method 3: Fallback to target SentencePiece model if source not available
        elif hasattr(tokenizer, 'tgt_spm') and tokenizer.tgt_spm is not None:
            serialized_sp_model = tokenizer.tgt_spm.serialized_model_proto()
            extraction_method = "indictrans_tgt_spm"
            print(f"✓ Extracted IndicTrans2 target SentencePiece model: {len(serialized_sp_model)} bytes")
            
        # Method 4: Try reading target SentencePiece model file directly
        elif hasattr(tokenizer, 'tgt_spm_fp') and tokenizer.tgt_spm_fp:
            import os
            if os.path.exists(tokenizer.tgt_spm_fp):
                with open(tokenizer.tgt_spm_fp, 'rb') as f:
                    serialized_sp_model = f.read()
                extraction_method = f"indictrans_tgt_file: {tokenizer.tgt_spm_fp}"
                print(f"✓ Extracted from IndicTrans2 target file: {len(serialized_sp_model)} bytes")
                
        # Method 5: Generic sp_model access (for other tokenizers)
        elif hasattr(tokenizer, 'sp_model') and tokenizer.sp_model is not None:
            serialized_sp_model = tokenizer.sp_model.serialized_model_proto()
            extraction_method = "generic_sp_model"
            print(f"✓ Extracted via generic sp_model: {len(serialized_sp_model)} bytes")
            
        # Method 6: Try to find .model file in tokenizer directory
        elif hasattr(tokenizer, 'name_or_path'):
            import os
            import glob
            
            # Look for .model files in the tokenizer directory
            base_path = tokenizer.name_or_path if os.path.isdir(tokenizer.name_or_path) else ""
            if base_path:
                model_files = glob.glob(os.path.join(base_path, "*.model"))
                if model_files:
                    model_file = model_files[0]  # Take the first .model file
                    with open(model_file, 'rb') as f:
                        serialized_sp_model = f.read()
                    extraction_method = f"model_file: {model_file}"
                    print(f"✓ Extracted from {model_file}: {len(serialized_sp_model)} bytes")
        
        # If we still don't have the model, provide detailed info
        if len(serialized_sp_model) == 0:
            print("⚠ Could not extract SentencePiece model")
            print("IndicTrans2 tokenizer analysis:")
            if hasattr(tokenizer, 'src_spm'):
                print(f"  - Has src_spm: {tokenizer.src_spm is not None}")
            if hasattr(tokenizer, 'tgt_spm'):
                print(f"  - Has tgt_spm: {tokenizer.tgt_spm is not None}")
            if hasattr(tokenizer, 'src_spm_fp'):
                print(f"  - Source model file: {tokenizer.src_spm_fp}")
            if hasattr(tokenizer, 'tgt_spm_fp'):
                print(f"  - Target model file: {tokenizer.tgt_spm_fp}")
                        
        return serialized_sp_model, extraction_method
        
    except Exception as e:
        print(f"Error in SentencePiece extraction: {e}")
        import traceback
        traceback.print_exc()
        return b"", "error"


def load_indictrans_model(model_path: Path):
    """Load IndicTrans2 model from directory or HuggingFace model name."""
    print(f"Loading IndicTrans2 model from {model_path}")
    
    # Convert Path to string for HuggingFace compatibility
    model_path_str = str(model_path)
    
    # Load config
    config = AutoConfig.from_pretrained(model_path_str, trust_remote_code=True)
    
    # Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(model_path_str, trust_remote_code=True)
    
    # Load model
    model = AutoModelForSeq2SeqLM.from_pretrained(
        model_path_str, 
        trust_remote_code=True,
        torch_dtype=torch.float32
    )
    
    # Get state dict
    state_dict = model.state_dict()
    
    return config, tokenizer, state_dict


def write_header(fout, config, quant_type: str = "f16"):
    """Write GGML header adapted for IndicTrans2 format."""
    # Magic number: "ggml" in hex
    fout.write(struct.pack("i", 0x67676d6c))
    
    # IndicTrans2 specific configuration
    encoder_vocab_size = getattr(config, 'encoder_vocab_size', config.vocab_size)
    decoder_vocab_size = getattr(config, 'decoder_vocab_size', config.vocab_size)
    
    # Use same header format as Marian for consistency
    fout.write(struct.pack("i", encoder_vocab_size))  # n_vocab (encoder vocab size)
    fout.write(struct.pack("i", config.max_source_positions))  # n_audio_ctx (encoder max positions)
    fout.write(struct.pack("i", config.encoder_embed_dim))  # n_audio_state (encoder embedding dim)
    fout.write(struct.pack("i", config.encoder_attention_heads))  # n_audio_head
    fout.write(struct.pack("i", config.encoder_layers))  # n_audio_layer
    fout.write(struct.pack("i", config.max_target_positions))  # n_text_ctx (decoder max positions)
    fout.write(struct.pack("i", config.decoder_embed_dim))  # n_text_state (decoder embedding dim)
    fout.write(struct.pack("i", config.decoder_attention_heads))  # n_text_head
    fout.write(struct.pack("i", config.decoder_layers))  # n_text_layer
    fout.write(struct.pack("i", 1))  # Model type: 1 = INDICTRANS (field_10)
    
    quant_type_map = {
        "f32": 0,
        "f16": 1, 
        "q4_0": 2
    }    
    quant_value = quant_type_map.get(quant_type, 1)
    fout.write(struct.pack("i", quant_value))  # quantization type
    
    # Write IndicTrans2-specific configuration parameters
    fout.write(struct.pack("i", decoder_vocab_size))  # decoder vocab size (field_12 - IndicTrans2 specific)
    fout.write(struct.pack("?", getattr(config, 'encoder_normalize_before', True)))  # encoder_normalize_before
    fout.write(struct.pack("?", getattr(config, 'decoder_normalize_before', True)))  # decoder_normalize_before
    fout.write(struct.pack("?", getattr(config, 'layernorm_embedding', True)))       # layernorm_embedding
    fout.write(struct.pack("?", getattr(config, 'scale_embedding', True)))           # scale_embedding
    share_tied = getattr(config, 'share_decoder_input_output_embed', True)
    has_lm_head = not share_tied
    fout.write(struct.pack("?", has_lm_head))
    # Write encoder_ffn_dim and decoder_ffn_dim for IndicTrans
    fout.write(struct.pack("i", getattr(config, 'encoder_ffn_dim', 2048)))
    fout.write(struct.pack("i", getattr(config, 'decoder_ffn_dim', 2048)))

    print(f"IndicTrans2 config written:")
    print(f"  encoder_normalize_before: {getattr(config, 'encoder_normalize_before', True)}")
    print(f"  decoder_normalize_before: {getattr(config, 'decoder_normalize_before', True)}")
    print(f"  layernorm_embedding: {getattr(config, 'layernorm_embedding', True)}")
    print(f"  scale_embedding: {getattr(config, 'scale_embedding', True)}")
    print(f"  has_lm_head (non-tied): {has_lm_head}")
    print(f"  encoder_ffn_dim: {getattr(config, 'encoder_ffn_dim', 2048)}")
    print(f"  decoder_ffn_dim: {getattr(config, 'decoder_ffn_dim', 2048)}")


def write_vocabulary(fout, tokenizer):
    """Write vocabulary in GGML format for IndicTrans2."""
    # Get vocabulary from tokenizer
    vocab = tokenizer.get_vocab()
    
    # Create ordered token list
    tokens = [""] * len(vocab)
    for token, token_id in vocab.items():
        tokens[token_id] = token
    
    print(f"Writing vocabulary with {len(tokens)} tokens")
    fout.write(struct.pack("i", len(tokens)))
    
    for token in tokens:
        token_bytes = token.encode('utf-8')
        fout.write(struct.pack("i", len(token_bytes)))
        fout.write(token_bytes)


def quantize_q4_0(data: np.ndarray):
    """
    Quantize tensor to Q4_0 format (GGML 4-bit quantization).
    Based on the actual GGML implementation in ggml-quants.c
    
    Q4_0 format: w = d * (q - 8) where:
    - d: scale factor (fp16) = max_value / -8
    - q: quantized value stored as 4-bit unsigned (0-15)
    - Block size: 32 values
    - Layout: first 16 values in lower nibbles, second 16 values in upper nibbles
    """
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
    """Write the common tensor header (dimensions, name, ftype)."""
    n_dims = len(shape)
    name_bytes = name.encode('utf-8')
    fout.write(struct.pack("iii", n_dims, len(name_bytes), ftype))
    
    # Write dimensions in reverse order (GGML convention)
    for i in range(n_dims):
        fout.write(struct.pack("i", shape[n_dims - 1 - i]))
    
    fout.write(name_bytes)


def should_quantize_tensor(name: str, data: np.ndarray) -> bool:
    """Determine if a tensor should be quantized based on its characteristics."""
    n_dims = len(data.shape)
    return (n_dims >= 2 and 
            "bias" not in name and 
            "layer_norm" not in name and 
            "layernorm" not in name)


def write_tensor(fout, name: str, data: np.ndarray, quant_type: str = "f16"):
    """Write a single tensor in GGML format."""
    
    # Determine the appropriate format for this tensor
    if quant_type == "q4_0" and should_quantize_tensor(name, data):
        # Use Q4_0 quantization for large tensors (weights)
        scales, quantized_data, original_shape, n_blocks = quantize_q4_0(data)
        ftype = 2  # Q4_0 quantization type (GGML_FTYPE_MOSTLY_Q4_0)
        ftype_string = "q4_0"
        
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string}, blocks={n_blocks})")
        
        write_tensor_header(fout, name, data.shape, ftype)
        
        # Write Q4_0 format: alternating scales and quantized blocks        
        scale_bytes = np.frombuffer(scales.tobytes(), dtype=np.uint8).reshape(n_blocks, 2)
        quantized_reshaped = quantized_data.reshape(n_blocks, 16)
        interleaved = np.concatenate([scale_bytes, quantized_reshaped], axis=1)
        interleaved.tofile(fout)
        
    elif quant_type == "f16" and should_quantize_tensor(name, data):
        # Use f16 for large tensors (weights)
        data = data.astype(np.float16)
        ftype = 1
        ftype_string = "f16"
        
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string})")
        
        write_tensor_header(fout, name, data.shape, ftype)
        data.tofile(fout)
        
    else:
        # Default to f32 for all other cases (small tensors, biases, layer norms, or explicit f32)
        data = data.astype(np.float32)
        ftype = 0
        ftype_string = "f32"
        
        print(f"Writing tensor: {name} {list(data.shape)} (ftype={ftype_string})")
        
        write_tensor_header(fout, name, data.shape, ftype)
        data.tofile(fout)


def get_indictrans_tensor_name_mapping():
    """Map IndicTrans2 tensor names to whisper.cpp expected names."""
    return {
        # Embeddings
        "model.shared.weight": "encoder.embeddings.weight",
        "model.encoder.embed_tokens.weight": "encoder.embeddings.weight",
        "model.decoder.embed_tokens.weight": "decoder.embeddings.weight",
        # Note: IndicTrans2 uses sinusoidal positional embeddings (no learnable weights)
        # "model.encoder.embed_positions.weight": "encoder.embed_positions.weight",  # Not present in IndicTrans2
        # "model.decoder.embed_positions.weight": "decoder.embed_positions.weight",  # Not present in IndicTrans2
        
        # Layer normalization for embeddings
        "model.encoder.layernorm_embedding.weight": "encoder.layer_norm.weight",
        "model.encoder.layernorm_embedding.bias": "encoder.layer_norm.bias",
        "model.decoder.layernorm_embedding.weight": "decoder.layer_norm.weight",
        "model.decoder.layernorm_embedding.bias": "decoder.layer_norm.bias",
        
        # Final layer norm
        "model.encoder.layer_norm.weight": "encoder.final_layer_norm.weight",
        "model.encoder.layer_norm.bias": "encoder.final_layer_norm.bias",
        "model.decoder.layer_norm.weight": "decoder.final_layer_norm.weight",
        "model.decoder.layer_norm.bias": "decoder.final_layer_norm.bias",
        
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
        
        # Decoder layers - self attention
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
        
        # Decoder layers - cross attention
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
        
        # Decoder layers - MLP
        "model.decoder.layers.{}.final_layer_norm.weight": "decoder.blocks.{}.mlp_ln.weight",
        "model.decoder.layers.{}.final_layer_norm.bias": "decoder.blocks.{}.mlp_ln.bias",
        "model.decoder.layers.{}.fc1.weight": "decoder.blocks.{}.mlp.0.weight",
        "model.decoder.layers.{}.fc1.bias": "decoder.blocks.{}.mlp.0.bias",
        "model.decoder.layers.{}.fc2.weight": "decoder.blocks.{}.mlp.2.weight",
        "model.decoder.layers.{}.fc2.bias": "decoder.blocks.{}.mlp.2.bias",
    }


def convert_tensor_name(original_name: str) -> str:
    """Convert IndicTrans2 tensor name to whisper.cpp expected name."""
    name_mapping = get_indictrans_tensor_name_mapping()
    
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
    
    # If no mapping found, return original name
    return original_name


def convert_indictrans_to_ggml(model_path: Path, output_path: Path, quant_type: str = "f16"):
    """Convert IndicTrans2 model to GGML format."""
    print(f"Loading IndicTrans2 model from {model_path}")
    print(f"Using quantization: {quant_type}")
    config, tokenizer, state_dict = load_indictrans_model(model_path)
    
    print(f"Model config: {config}")
    print(f"Vocabulary size: {len(tokenizer.get_vocab())}")
    print(f"Total tensors: {len(state_dict)}")
    
    share_tied = getattr(config, 'share_decoder_input_output_embed', True)
    print(f"share_decoder_input_output_embed: {share_tied}")
    
    # Get vocabulary information
    vocab = tokenizer.get_vocab()
    vocab_tokens = [""] * len(vocab)
    for token, idx in vocab.items():
        vocab_tokens[idx] = token
    
    print(f"Vocabulary size: {len(vocab_tokens)}")
    
    print("Extracting IndicTrans2 dual SentencePiece models...")
    src_sp_model, tgt_sp_model, src_vocab_size, tgt_vocab_size = extract_indictrans_dual_sentencepiece_models(tokenizer)
    print(f"Final SentencePiece models: src={len(src_sp_model)} bytes, tgt={len(tgt_sp_model)} bytes")
    
    with open(output_path, 'wb') as fout:
        print("Writing header...")
        write_header(fout, config, quant_type)
        
        print("Writing vocabulary...")
        write_vocabulary(fout, tokenizer)
        
        print(f"Writing SentencePiece models: src={len(src_sp_model)} bytes, tgt={len(tgt_sp_model)} bytes")
        
        fout.write(struct.pack("i", len(src_sp_model)))
        if len(src_sp_model) > 0:
            fout.write(src_sp_model)
            
        fout.write(struct.pack("i", len(tgt_sp_model)))
        if len(tgt_sp_model) > 0:
            fout.write(tgt_sp_model)
            
        print("Writing target encoder vocabulary mapping...")
        tgt_encoder = tokenizer.tgt_encoder
        print(f"Target encoder vocab size: {len(tgt_encoder)}")
        
        fout.write(struct.pack("i", len(tgt_encoder)))
        
        for token, token_id in tgt_encoder.items():
            fout.write(struct.pack("i", token_id))
            token_bytes = token.encode('utf-8')
            fout.write(struct.pack("i", len(token_bytes)))
            fout.write(token_bytes)
        
        print(f"Converting {len(state_dict)} tensors...")
        shared_tensor = None
        
        for name, tensor in state_dict.items():
            # Handle shared embeddings
            if name == "model.shared.weight":
                shared_tensor = tensor.clone()
            
            # Skip duplicate embeddings if they exist
            if name == "model.encoder.embed_tokens.weight" and "model.shared.weight" in state_dict:
                if torch.equal(tensor, state_dict["model.shared.weight"]):
                    print(f"Skipping duplicate tensor: {name} (same as shared)")
                    continue
            
            # Conditionally include lm_head when not sharing input/output embeddings
            if "lm_head" in name:
                if share_tied:
                    print(f"Skipping IndicTrans2 lm_head tensor: {name} (uses shared embeddings)")
                    continue
                else:
                    print(f"Including lm_head tensor: {name} (non-shared output head)")
            
            # Convert tensor name
            ggml_name = convert_tensor_name(name)
            
            # Convert to numpy
            if tensor.dtype == torch.float16:
                np_tensor = tensor.to(torch.float32).numpy()
            else:
                np_tensor = tensor.numpy()
            
            write_tensor(fout, ggml_name, np_tensor, quant_type)
        
        if shared_tensor is not None and share_tied:
            print("IndicTrans2 uses shared embeddings (model.shared.weight) - lm_head is tied")
    
    print(f"Conversion complete! GGML file saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Convert IndicTrans2 model to GGML format")
    parser.add_argument("--model-name", type=str, required=True,
                        help="HuggingFace model name or path to local model directory")
    parser.add_argument("--output", type=str, default=None,
                        help="Output GGML file path (default: auto-generated based on model and quantization)")
    parser.add_argument("--quant", type=str, default="f16", 
                        choices=["f32", "f16", "q4_0"],
                        help="Quantization type: f32 (no quantization), f16 (half precision), q4_0 (4-bit quantization) (default: f16)")
    
    args = parser.parse_args()
    
    model_path = Path(args.model_name)
    quant_type = args.quant
    
    # Auto-generate output filename if not provided
    if args.output is None:
        model_name = args.model_name.split('/')[-1] if '/' in args.model_name else args.model_name
        output_filename = f"ggml-{model_name}-{quant_type}.bin"
        output_path = Path(output_filename)
    else:
        output_path = Path(args.output)
    
    # Check if it's a local path or HuggingFace model name
    if model_path.exists() and model_path.is_dir():
        print(f"Using local model directory: {model_path}")
    else:
        print(f"Using HuggingFace model: {args.model_name}")
        model_path = args.model_name
    
    try:
        convert_indictrans_to_ggml(model_path, output_path, quant_type)
        return 0
    except Exception as e:
        print(f"Error during conversion: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main()) 