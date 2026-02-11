import argparse
import json
import os
import time
from datetime import datetime

import psutil
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
try:
    from transformers.cache_utils import QuantizedCache
except Exception:
    QuantizedCache = None
from transformers.utils import logging as hf_logging

hf_logging.set_verbosity_error()


def log(message):
    ts = datetime.utcnow().isoformat()
    print(f"[{ts}] {message}", flush=True)


def capture_memory():
    process = psutil.Process(os.getpid())
    return {"rssBytes": process.memory_info().rss}


def format_prompt_for_tokenizer(tokenizer, messages):
    """
    Format messages using the tokenizer's chat template if available.
    Falls back to manual formatting if chat template is not available.
    
    This ensures compatibility with models like Qwen that require specific formatting.
    """
    # Try to use the tokenizer's chat template (preferred for instruction-tuned models)
    if hasattr(tokenizer, 'apply_chat_template') and tokenizer.chat_template:
        try:
            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True
            )
        except Exception as exc:
            # Fallback to manual formatting if chat template fails
            log(f"Chat template failed: {exc}, using manual formatting")
            pass
    
    # Fallback: manual formatting for models without chat template
    return "\n".join([f"{m['role']}: {m['content']}" for m in messages]) + "\nassistant:"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.path.join(os.path.dirname(__file__), "perf-config.json"))
    parser.add_argument("--params", default=None)
    parser.add_argument("--reps", type=int, default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--quick", action="store_true")
    return parser.parse_args()


def read_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def resolve_params_to_run(config, params_arg):
    if not params_arg or params_arg == "all":
        return list(config["params"].keys())
    return [p.strip() for p in params_arg.split(",") if p.strip()]


def resolve_param_value(value):
    if value == "{max}":
        return str(os.cpu_count())
    return value


def pick_quick_values(values, baseline_value):
    picked = []
    def add_value(value):
        if value not in picked:
            picked.append(value)
    add_value(baseline_value)
    for raw in values or []:
        normalized = None if raw is None else raw
        if normalized != baseline_value:
            add_value(normalized)
            break
    return picked


def is_quantization_supported(quantization, device):
    """
    Check if quantization is supported on the given device/platform.
    
    Bitsandbytes (bnb) 4/8-bit quantization:
    - Not supported on macOS MPS (GPU) - falls back to CPU and is very slow
    - Not supported on CPU anywhere (bitsandbytes is CUDA-only)
    - Only supported on CUDA (Linux/Windows with NVIDIA GPU)
    
    FP16 is supported on all platforms (MPS, CUDA, CPU).
    """
    platform = os.uname().sysname.lower() if hasattr(os, "uname") else ""
    if (device == "cpu" or platform == "darwin") and quantization in ("bnb-4bit", "bnb-8bit"):
        return False
    return True


def supported_quantization_values(config):
    """
    Filter quantization values based on platform capabilities.
    
    On macOS (darwin): Only F16 is supported (MPS doesn't support bitsandbytes quantization).
    On Linux/Windows: All quantization values are supported (full bitsandbytes support on CUDA).
    """
    platform = os.uname().sysname.lower() if hasattr(os, "uname") else ""
    values = config.get("params", {}).get("quantization", [])
    if platform == "darwin":
        # macOS MPS limitation: only F16 supported
        return [v for v in values if v == "F16"]
    # Linux/Windows: full support (Q4_0, Q4_K_M, Q8_0, F16 all work on CUDA)
    return values


def create_run_id():
    return f"{int(time.time() * 1000)}-{os.urandom(4).hex()}"


def resolve_output_path(output_arg, model_id):
    if output_arg:
        return output_arg
    results_dir = os.path.join(os.path.dirname(__file__), "results")
    os.makedirs(results_dir, exist_ok=True)
    timestamp = datetime.utcnow().isoformat().replace(":", "-").replace(".", "-")
    hostname = os.uname().nodename if hasattr(os, "uname") else "machine"
    model_tag = f"_{model_id}" if model_id else ""
    return os.path.join(results_dir, f"torch_{hostname}{model_tag}_{timestamp}.jsonl")


def load_torch_model(
    model_id,
    quantization,
    device,
    flash_attn,
    no_mmap,
    no_kv_offload,
    cache_type_k,
    cache_type_v,
    hf_token=None,
):
    if device == "cpu":
        kwargs = {"device_map": "cpu", "torch_dtype": torch.float32}
    else:
        # For GPU: detect available backend (MPS on macOS, CUDA on Linux/Windows)
        # device_map="auto" handles MPS/CUDA automatically, but we need explicit mapping
        # when no-kv-offload is set to ensure KV cache stays on device
        if no_kv_offload:
            # Check MPS first (macOS), then CUDA (Linux/Windows)
            # On Linux, mps.is_available() returns False, so it falls through to CUDA
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                kwargs = {"device_map": "mps"}
            elif torch.cuda.is_available():
                kwargs = {"device_map": {"": 0}}
            else:
                raise RuntimeError("No GPU backend available (MPS or CUDA)")
        else:
            # device_map="auto" automatically selects MPS or CUDA based on availability
            kwargs = {"device_map": "auto"}
    kwargs["torch_dtype"] = torch.float16
    # Flash attention 2 requires the flash-attn package (CUDA kernels) and CUDA device
    # It does not work on MPS (macOS) - flash-attn is a CUDA-only library
    if flash_attn and device != "cpu":
        try:
            from transformers.utils import is_flash_attn_2_available
            if is_flash_attn_2_available() and torch.cuda.is_available():
                kwargs["attn_implementation"] = "flash_attention_2"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                # Flash attention not available on MPS - silently skip
                pass
        except (ImportError, AttributeError):
            # transformers.utils not available or flash-attn check fails
            if torch.cuda.is_available():
                # Try anyway if CUDA is available
                kwargs["attn_implementation"] = "flash_attention_2"
    # llama.cpp default: mmap (memory-mapping, lazy loading from disk)
    # llama.cpp --no-mmap: full load into RAM (no memory-mapping)
    # PyTorch default: full load into RAM (no mmap equivalent)
    # PyTorch low_cpu_mem_usage=True: memory optimizations (not mmap, but closer to memory-efficient)
    # 
    # Since PyTorch doesn't have true mmap, we map:
    # - llama.cpp --no-mmap (full load) → PyTorch default (full load) - don't set low_cpu_mem_usage
    # - llama.cpp default (mmap) → PyTorch low_cpu_mem_usage=True (best-effort approximation)
    if not no_mmap:
        # llama.cpp uses mmap (default) - use PyTorch memory optimizations as best-effort approximation
        kwargs["low_cpu_mem_usage"] = True
    # else: llama.cpp uses --no-mmap (full load) - use PyTorch default (also full load)
    if quantization == "bnb-4bit":
        kwargs["load_in_4bit"] = True
    elif quantization == "bnb-8bit":
        kwargs["load_in_8bit"] = True

    # CUDA-specific optimizations (TF32, matmul precision) don't apply to MPS
    if device != "cpu" and torch.cuda.is_available():
        if cache_type_k in ("q8_0", "q4_0") or cache_type_v in ("q8_0", "q4_0"):
            torch.backends.cuda.matmul.allow_tf32 = True
        if cache_type_k == "q4_0" or cache_type_v == "q4_0":
            torch.set_float32_matmul_precision("medium")
    else:
        torch.set_float32_matmul_precision("high")
    model = AutoModelForCausalLM.from_pretrained(model_id, token=hf_token, **kwargs)
    tokenizer = AutoTokenizer.from_pretrained(model_id, token=hf_token)
    return model, tokenizer


def resolve_kv_cache_bits(cache_type_k, cache_type_v):
    if cache_type_k != cache_type_v:
        raise RuntimeError(
            f"PyTorch quantized KV cache requires cache-type-k == cache-type-v (got {cache_type_k} vs {cache_type_v})"
        )
    if not cache_type_k or cache_type_k == "f16":
        return None
    if cache_type_k == "q4_0":
        return 4
    if cache_type_k == "q8_0":
        return 8
    raise RuntimeError(f"Unsupported KV cache quantization type: {cache_type_k}")


def create_quantized_kv_cache(cache_type_k, cache_type_v, model):
    nbits = resolve_kv_cache_bits(cache_type_k, cache_type_v)
    if nbits is None:
        return None, None
    if QuantizedCache is None:
        raise RuntimeError("QuantizedCache is unavailable in transformers; upgrade transformers to enable KV quantization")
    try:
        import quanto  # noqa: F401
    except Exception as exc:
        raise RuntimeError("KV cache quantization requires the 'quanto' package") from exc
    return QuantizedCache(backend="quanto", config=model.config, nbits=nbits), nbits


def determine_max_threads(config, params_to_run, quick):
    baseline_threads = int(config.get("baseline", {}).get("threads", "0") or 0)
    if "threads" not in params_to_run:
        return baseline_threads if baseline_threads > 0 else os.cpu_count() or 1

    values = config.get("params", {}).get("threads", [])
    if quick:
        values = pick_quick_values(values, config.get("baseline", {}).get("threads"))

    resolved = []
    for raw in values or []:
        resolved_value = resolve_param_value(raw)
        if resolved_value is None or resolved_value == "":
            continue
        try:
            resolved.append(int(resolved_value))
        except ValueError:
            continue

    if baseline_threads > 0:
        resolved.append(baseline_threads)

    if not resolved:
        return os.cpu_count() or 1

    # Interop threads can only be set once per process, so we pick the max
    # value the sweep might request and set it up-front.
    return max(resolved)


def run_once(
    baseline,
    model_config,
    prompt,
    param_name,
    param_value,
    rep_index,
    output_path,
    hf_token,
):
    resolved_value = resolve_param_value(param_value)
    config = dict(baseline)
    config[param_name] = resolved_value
    if prompt.get("n_predict"):
        config["n_predict"] = str(prompt["n_predict"])

    model_variant = resolved_value if param_name == "quantization" else baseline["quantization"]
    variant_config = model_config.get("torch", {}).get(model_variant)
    if not variant_config:
        raise RuntimeError(f"Missing PyTorch model variant config for {model_variant}")

    model_id = variant_config["modelId"]
    quantization = variant_config.get("quantization", "fp16")
    device = config.get("device", "gpu")
    if not is_quantization_supported(quantization, device):
        raise RuntimeError(f"Quantization {quantization} is not supported on device={device}")
    no_mmap = config.get("no-mmap") is not None
    no_kv_offload = config.get("no-kv-offload") is not None
    flash_attn = config.get("flash-attn") is not None
    cache_type_k = config.get("cache-type-k") or "f16"
    cache_type_v = config.get("cache-type-v") or "f16"
    threads = int(config.get("threads", "0") or 0)
    if threads > 0:
        torch.set_num_threads(threads)

    log(
        f"Starting run: model={model_config['id']} {param_name}={resolved_value} "
        f"prompt={prompt['id']} rep={rep_index}"
    )
    load_start = time.time()
    log("Loading PyTorch model")
    model, tokenizer = load_torch_model(
        model_id,
        quantization,
        device,
        flash_attn,
        no_mmap,
        no_kv_offload,
        cache_type_k,
        cache_type_v,
        hf_token=hf_token,
    )
    model_load_ms = (time.time() - load_start) * 1000.0
    log(f"Model loaded in {model_load_ms:.1f}ms")
    memory_load = capture_memory()

    kv_cache_prefill, kv_cache_bits = create_quantized_kv_cache(cache_type_k, cache_type_v, model)

    # Format prompt using tokenizer's chat template (required for Qwen and other instruction-tuned models)
    prompt_text = format_prompt_for_tokenizer(tokenizer, prompt["messages"])
    batch_size = int(config.get("batch-size", "1"))
    ubatch_size = int(config.get("ubatch-size", str(batch_size)))
    if ubatch_size > batch_size:
        raise RuntimeError(f"ubatch-size {ubatch_size} must be <= batch-size {batch_size}")
    ctx_size = int(config.get("ctx_size", "0") or 0)

    # QVAC batch-size/ubatch-size control token-batching for a single prompt in llama.cpp.
    # For PyTorch, we keep a single prompt and use these values as prefill chunk sizes.
    prompt_texts = [prompt_text]
    tokenizer_kwargs = dict(return_tensors="pt", padding=False)
    if ctx_size > 0:
        tokenizer_kwargs["truncation"] = True
        tokenizer_kwargs["max_length"] = ctx_size
    try:
        inputs = tokenizer(prompt_texts, **tokenizer_kwargs)
    except Exception as exc:
        raise RuntimeError(
            f"Tokenizer failed for prompt '{prompt['id']}': {exc}. "
            f"Prompt text length: {len(prompt_text)}, ctx_size: {ctx_size}"
        ) from exc
    
    input_ids = inputs.input_ids.to(model.device)
    attention_mask = inputs.attention_mask.to(model.device) if hasattr(inputs, "attention_mask") else None
    
    # Validate tokenization result
    if input_ids.shape[0] == 0 or input_ids.shape[1] == 0:
        raise RuntimeError(
            f"Tokenizer returned empty input_ids. "
            f"Prompt text length: {len(prompt_text)}, "
            f"input_ids shape: {input_ids.shape}, "
            f"ctx_size: {ctx_size}, "
            f"tokenizer_kwargs: {tokenizer_kwargs}"
        )
    
    if attention_mask is not None:
        prompt_tokens = int(attention_mask.sum().item())
    else:
        prompt_tokens = int(input_ids.numel())
    max_prompt_len = int(input_ids.shape[1])
    seq_len = max_prompt_len

    # Validate that the prompt was tokenized into at least one token
    if seq_len == 0:
        raise RuntimeError(
            f"Prompt tokenization resulted in 0 tokens. "
            f"Prompt text length: {len(prompt_text)}, "
            f"input_ids shape: {input_ids.shape}, "
            f"ctx_size: {ctx_size}"
        )

    max_new_tokens = int(config.get("n_predict", "256"))
    if ctx_size > 0:
        max_new_tokens = min(max_new_tokens, max(ctx_size - max_prompt_len, 0))

    # Validate that there's room for at least one new token
    if max_new_tokens <= 0:
        raise RuntimeError(
            f"No room for generation: ctx_size={ctx_size}, prompt_tokens={prompt_tokens}, "
            f"max_prompt_len={max_prompt_len}, max_new_tokens={max_new_tokens}. "
            f"Prompt exceeds or fills the context window."
        )

    # Transformers TextStreamer only supports batch size 1. We approximate TTFT
    # with chunked prefill (token batching) and a single forward pass for the next token.
    log(
        f"Running prefill: tokenBatch={batch_size} tokenMicroBatch={ubatch_size} "
        f"promptTokens={prompt_tokens} maxNew={max_new_tokens}"
    )
    first_token_ms = None
    with torch.no_grad():
        ttft_start = time.time()
        past_key_values = kv_cache_prefill
        prefill_batch = max(batch_size, 1)
        prefill_micro_batch = max(min(ubatch_size, batch_size), 1)
        # Process all tokens except the last one in the prefill loop.
        # The last token will be processed in the decode step below to estimate TTFT.
        prefill_len = max(seq_len - 1, 0)  # Exclude last token from prefill
        for start in range(0, prefill_len, prefill_batch):
            end = min(start + prefill_batch, prefill_len)
            for micro_start in range(start, end, prefill_micro_batch):
                micro_end = min(micro_start + prefill_micro_batch, end)
                # Skip empty chunks (shouldn't happen, but defensive check)
                if micro_end <= micro_start:
                    continue
                chunk_ids = input_ids[:, micro_start:micro_end]
                # Validate chunk is not empty
                if chunk_ids.shape[0] == 0 or chunk_ids.shape[1] == 0:
                    raise RuntimeError(
                        f"Empty chunk in prefill: micro_start={micro_start}, micro_end={micro_end}, "
                        f"chunk_ids.shape={chunk_ids.shape}, input_ids.shape={input_ids.shape}"
                    )
                chunk_mask = attention_mask[:, micro_start:micro_end] if attention_mask is not None else None
                outputs = model(
                    input_ids=chunk_ids,
                    attention_mask=chunk_mask,
                    past_key_values=past_key_values,
                    use_cache=True,
                )
                past_key_values = outputs.past_key_values
        # Process the last token once to estimate first-token latency (decode step).
        # This token was excluded from the prefill loop above to avoid double-processing.
        # Save past_key_values BEFORE processing the last token - this will be used for generation.
        # past_key_values_for_generation contains KV cache for tokens 0 to seq_len-2 (all except last token).
        past_key_values_for_generation = past_key_values
        first_token_logits = None
        if seq_len > 0:
            # Defensive check: ensure input_ids is valid before slicing
            if input_ids.shape[0] == 0:
                raise RuntimeError(
                    f"Empty batch dimension in input_ids: shape={input_ids.shape}, seq_len={seq_len}"
                )
            if input_ids.shape[1] == 0:
                raise RuntimeError(
                    f"Empty sequence dimension in input_ids: shape={input_ids.shape}, seq_len={seq_len}"
                )
            if input_ids.shape[1] < seq_len:
                raise RuntimeError(
                    f"input_ids sequence length ({input_ids.shape[1]}) < seq_len ({seq_len})"
                )
            last_token = input_ids[:, -1:]
            # Validate that last_token is not empty
            if last_token.shape[0] == 0 or last_token.shape[1] == 0:
                raise RuntimeError(
                    f"Empty last_token: shape={last_token.shape}, "
                    f"input_ids.shape={input_ids.shape}, seq_len={seq_len}"
                )
            last_mask = attention_mask[:, -1:] if attention_mask is not None else None
            if attention_mask is not None and (last_mask.shape[0] == 0 or last_mask.shape[1] == 0):
                raise RuntimeError(
                    f"Empty last_mask: shape={last_mask.shape}, "
                    f"attention_mask.shape={attention_mask.shape}, seq_len={seq_len}"
                )
            outputs = model(
                input_ids=last_token,
                attention_mask=last_mask,
                past_key_values=past_key_values,
                use_cache=True,
            )
            # past_key_values now contains KV cache for ALL prompt tokens (0 to seq_len-1)
            # But we use past_key_values_for_generation (without last token) for model.generate()
            # Extract logits for the first generated token (used to start generation)
            # Validate that logits have the expected shape
            if outputs.logits.shape[0] == 0:
                raise RuntimeError(
                    f"Empty logits tensor: outputs.logits.shape={outputs.logits.shape}, "
                    f"last_token.shape={last_token.shape}"
                )
            if outputs.logits.shape[1] == 0:
                raise RuntimeError(
                    f"Logits tensor has zero sequence length: outputs.logits.shape={outputs.logits.shape}, "
                    f"last_token.shape={last_token.shape}"
                )
            first_token_logits = outputs.logits[:, -1, :]  # Shape: [batch_size, vocab_size]
            # Validate that first_token_logits is not empty
            if first_token_logits.shape[0] == 0:
                raise RuntimeError(
                    f"Empty first_token_logits after extraction: shape={first_token_logits.shape}, "
                    f"outputs.logits.shape={outputs.logits.shape}"
                )
            if first_token_logits.shape[1] == 0:
                raise RuntimeError(
                    f"first_token_logits has zero vocab size: shape={first_token_logits.shape}, "
                    f"outputs.logits.shape={outputs.logits.shape}"
                )
        first_token_ms = (time.time() - ttft_start) * 1000.0
    log(f"Forward pass complete (TTFT={first_token_ms:.1f}ms)")

    total_generated_tokens = 0
    output_text = ""

    # Use the populated KV cache from prefill phase for generation
    # past_key_values_for_generation contains KV cache for tokens 0 to seq_len-2 (all except last token).
    # We pass the last prompt token as input_ids, and model.generate() will:
    # 1. Process the last token with the cached KV (tokens 0 to seq_len-2)
    # 2. Generate the first token and subsequent tokens
    gen_start = time.time()
    # Determine input_ids for generation
    # If we have past_key_values_for_generation (from prefill), use only the last token.
    # Otherwise, use the full input_ids (fallback for seq_len==1 or when kv_cache_prefill is None).
    if seq_len > 0:
        # Defensive check: ensure input_ids is valid before slicing
        if input_ids.shape[0] == 0:
            raise RuntimeError(
                f"Cannot generate: empty batch dimension in input_ids (seq_len={seq_len}, shape={input_ids.shape})"
            )
        if input_ids.shape[1] == 0:
            raise RuntimeError(
                f"Cannot generate: empty sequence dimension in input_ids (seq_len={seq_len}, shape={input_ids.shape})"
            )
        if input_ids.shape[1] < seq_len:
            raise RuntimeError(
                f"Cannot generate: input_ids sequence length ({input_ids.shape[1]}) < seq_len ({seq_len})"
            )
        
        if past_key_values_for_generation is not None and seq_len > 1:
            # past_key_values_for_generation contains KV cache for tokens 0 to seq_len-2 (all except last token).
            # Pass the last prompt token as input_ids so model.generate() can process it and continue generation.
            generate_input_ids = input_ids[:, -1:]  # Last prompt token
            # Validate the slice result
            if generate_input_ids.shape[0] == 0 or generate_input_ids.shape[1] == 0:
                raise RuntimeError(
                    f"Empty generate_input_ids after slicing: shape={generate_input_ids.shape}, "
                    f"input_ids.shape={input_ids.shape}, seq_len={seq_len}"
                )
            generate_attention_mask = attention_mask[:, -1:] if attention_mask is not None else None
            if attention_mask is not None and generate_attention_mask is not None:
                if generate_attention_mask.shape[0] == 0 or generate_attention_mask.shape[1] == 0:
                    raise RuntimeError(
                        f"Empty generate_attention_mask after slicing: shape={generate_attention_mask.shape}, "
                        f"attention_mask.shape={attention_mask.shape}, seq_len={seq_len}"
                    )
        else:
            # Fallback: if no prefill was done (seq_len==1) or kv_cache_prefill is None, use the original input_ids
            # This ensures we always have valid input_ids for generation
            generate_input_ids = input_ids
            generate_attention_mask = attention_mask
            # If we're using full input_ids, don't pass past_key_values (model will process from scratch)
            past_key_values_for_generation = None
    else:
        raise RuntimeError(
            f"Cannot generate: seq_len={seq_len}, input_ids.shape={input_ids.shape}"
        )
    
    # Final validation before model.generate()
    if max_new_tokens <= 0:
        raise RuntimeError(
            f"Cannot generate: max_new_tokens={max_new_tokens} must be > 0. "
            f"ctx_size={ctx_size}, prompt_tokens={prompt_tokens}, max_prompt_len={max_prompt_len}, seq_len={seq_len}"
        )
    if generate_input_ids.shape[0] == 0 or generate_input_ids.shape[1] == 0:
        raise RuntimeError(
            f"Cannot generate: generate_input_ids is empty (shape={generate_input_ids.shape}, "
            f"input_ids.shape={input_ids.shape}, seq_len={seq_len})"
        )
    
    try:
        generated = model.generate(
            input_ids=generate_input_ids,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            use_cache=True,
            attention_mask=generate_attention_mask,
            past_key_values=past_key_values_for_generation,  # Contains KV cache for tokens 0 to seq_len-2
        )
    except Exception as exc:
        raise RuntimeError(
            f"model.generate() failed: {exc}. "
            f"generate_input_ids.shape={generate_input_ids.shape}, "
            f"max_new_tokens={max_new_tokens}, "
            f"past_key_values_for_generation={'present' if past_key_values_for_generation is not None else 'None'}, "
            f"seq_len={seq_len}, prompt_tokens={prompt_tokens}"
        ) from exc
    # Validate that generated tensor is not empty
    if generated.shape[0] == 0:
        raise RuntimeError(
            f"model.generate() returned empty tensor: generated.shape={generated.shape}, "
            f"generate_input_ids.shape={generate_input_ids.shape}, max_new_tokens={max_new_tokens}"
        )
    if generated.shape[1] == 0:
        raise RuntimeError(
            f"model.generate() returned zero-length sequence: generated.shape={generated.shape}, "
            f"generate_input_ids.shape={generate_input_ids.shape}, max_new_tokens={max_new_tokens}"
        )
    generated_len = int(generated.shape[1])
    # When we pass the last prompt token to model.generate() with past_key_values:
    # - The output includes: 1 token from input (last prompt token) + max_new_tokens generated tokens
    # - generated_len = 1 + max_new_tokens
    # - We must exclude the input token (last prompt token) from the count
    # - total_generated_tokens should only count tokens generated by model.generate(), not the input token
    input_token_count = int(generate_input_ids.shape[1])
    total_generated_tokens = max(generated_len - input_token_count, 0)
    # Decode all generated tokens (last prompt token + all newly generated tokens)
    output_text = tokenizer.decode(
        generated[0], skip_special_tokens=True
    )
    log("Generation complete")

    end_time = time.time()

    # Generation timing only covers the generate() loop; TTFT is measured earlier.
    # generation_time measures the entire model.generate() call, which generates max_new_tokens tokens.
    # total_generated_tokens correctly excludes the input token (last prompt token) that was passed to generate().
    # This ensures TPS only counts tokens generated during the generation phase, not the input token.
    generation_time = max(end_time - gen_start, 1e-6)
    tps = total_generated_tokens / generation_time
    output_tokens = total_generated_tokens

    memory_end = capture_memory()

    unload_start = time.time()
    del model
    torch.cuda.empty_cache()
    model_unload_ms = (time.time() - unload_start) * 1000.0
    memory_unload = capture_memory()

    result = {
        "runId": create_run_id(),
        "timestamp": datetime.utcnow().isoformat(),
        "machine": os.uname().nodename if hasattr(os, "uname") else "unknown",
        "arch": os.uname().machine if hasattr(os, "uname") else "unknown",
        "platform": os.uname().sysname.lower() if hasattr(os, "uname") else "unknown",
        "backend": "torch",
        "gpu": None,
        "impl": "pytorch",
        "model": model_id,
        "modelId": model_config["id"],
        "config": {
            **config,
            "quantization": model_variant,
            "modelId": model_config["id"],
            **({"kvCacheBackend": "quanto", "kvCacheBits": kv_cache_bits} if kv_cache_bits else {})
        },
        "perfParam": param_name,
        "perfValue": resolved_value,
        "promptId": prompt["id"],
        "promptText": prompt_text,
        "promptTokens": prompt_tokens,
        "modelLoadMs": model_load_ms,
        "modelUnloadMs": model_unload_ms,
        "ttftMs": first_token_ms,
        "tps": tps,
        "generatedTokens": output_tokens,
        "promptTokensPerTtft": (prompt_tokens / first_token_ms) if first_token_ms else None,
        "memory": {
            "load": memory_load,
            "end": memory_end,
            "unload": memory_unload
        },
        "outputText": output_text,
        "rep": rep_index
    }

    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(result) + "\n")
    log(
        f"Completed run: model={model_config['id']} {param_name}={resolved_value} "
        f"prompt={prompt['id']} rep={rep_index}"
    )


def main():
    args = parse_args()
    config = read_config(args.config)
    params_to_run = resolve_params_to_run(config, args.params)
    reps = 1 if args.quick else (args.reps if args.reps is not None else config["reps"])
    output_path = resolve_output_path(args.output, config["baseline"].get("modelId"))
    models_to_run = config.get("models", [])
    if len(models_to_run) == 0:
        raise SystemExit('perf-config.json must include at least one model in "models"')
    if args.quick:
        baseline_model_id = config.get("baseline", {}).get("modelId")
        baseline_model = next((m for m in models_to_run if m.get("id") == baseline_model_id), None)
        models_to_run = [baseline_model] if baseline_model else [models_to_run[0]]
        if config.get("prompts"):
            config["prompts"] = [config["prompts"][0]]
    hf_token = args.hf_token or os.getenv("HF_TOKEN")
    if hf_token:
        os.environ["HF_TOKEN"] = hf_token
    quantization_values = supported_quantization_values(config)
    max_threads = determine_max_threads(config, params_to_run, args.quick)
    if max_threads > 0:
        torch.set_num_interop_threads(max(1, max_threads // 2))

    for model_config in models_to_run:
        for param_name in params_to_run:
            values = config["params"].get(param_name)
            if not values:
                print(f"Unknown param: {param_name}, skipping")
                continue
            if param_name == "quantization":
                values = quantization_values
                if not values:
                    print("No supported quantizations for this platform, skipping")
                    continue
            if args.quick:
                baseline_value = config["baseline"].get(param_name)
                if param_name == "quantization":
                    baseline_value = config["baseline"].get("quantization")
                    if quantization_values and baseline_value not in quantization_values:
                        baseline_value = quantization_values[0]
                values = pick_quick_values(values, baseline_value)
            for raw_value in values:
                value = None if raw_value is None else raw_value
                for prompt in config["prompts"]:
                    for rep in range(1, reps + 1):
                        baseline_quantization = config["baseline"]["quantization"]
                        if quantization_values and baseline_quantization not in quantization_values:
                            baseline_quantization = quantization_values[0]
                        model_variant = value if param_name == "quantization" else baseline_quantization
                        variant_config = model_config.get("torch", {}).get(model_variant)
                        if not variant_config:
                            print(f"Missing PyTorch model variant config for {model_variant}, skipping")
                            continue
                        quantization = variant_config.get("quantization", "fp16")
                        device = (value if param_name == "device" else config["baseline"].get("device", "gpu")) or "gpu"
                        if not is_quantization_supported(quantization, device):
                            print(f"Skipping {model_config['id']} {model_variant} on this platform (unsupported quantization)")
                            continue
                        try:
                            run_once(
                                baseline={**config["baseline"], "quantization": baseline_quantization, "modelId": model_config["id"]},
                                model_config=model_config,
                                prompt=prompt,
                                param_name=param_name,
                                param_value=value,
                                rep_index=rep,
                                output_path=output_path,
                                hf_token=hf_token,
                            )
                        except Exception as exc:
                            log(
                                f"Run failed: model={model_config['id']} {param_name}={value} "
                                f"prompt={prompt['id']} rep={rep} error={exc}"
                            )
                            error_result = {
                                "runId": create_run_id(),
                                "timestamp": datetime.utcnow().isoformat(),
                                "impl": "pytorch",
                                "modelId": model_config["id"],
                                "perfParam": param_name,
                                "perfValue": value,
                                "promptId": prompt["id"],
                                "rep": rep,
                                "error": str(exc),
                            }
                            with open(output_path, "a", encoding="utf-8") as handle:
                                handle.write(json.dumps(error_result) + "\n")


if __name__ == "__main__":
    main()
