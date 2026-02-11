import argparse
import json
import os
import time
from datetime import datetime

import psutil
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.utils import logging as hf_logging

hf_logging.set_verbosity_error()


def now_ms():
    return time.time() * 1000.0


def log(message):
    ts = datetime.utcnow().isoformat()
    print(f"[{ts}] {message}", flush=True)


def capture_memory():
    process = psutil.Process(os.getpid())
    return {"rssBytes": process.memory_info().rss}


def stringify_prompt(messages):
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
    platform = os.uname().sysname.lower() if hasattr(os, "uname") else ""
    if (device == "cpu" or platform == "darwin") and quantization in ("bnb-4bit", "bnb-8bit"):
        return False
    return True


def supported_quantization_values(config):
    platform = os.uname().sysname.lower() if hasattr(os, "uname") else ""
    values = config.get("params", {}).get("quantization", [])
    if platform == "darwin":
        return [v for v in values if v == "F16"]
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
        if no_kv_offload:
            kwargs = {"device_map": {"": 0}}
        else:
            kwargs = {"device_map": "auto"}
        kwargs["torch_dtype"] = torch.float16
    if flash_attn and device != "cpu":
        kwargs["attn_implementation"] = "flash_attention_2"
    if no_mmap:
        kwargs["low_cpu_mem_usage"] = False
    else:
        kwargs["low_cpu_mem_usage"] = True
    if quantization == "bnb-4bit":
        kwargs["load_in_4bit"] = True
    elif quantization == "bnb-8bit":
        kwargs["load_in_8bit"] = True
    elif device == "cpu":
        kwargs["torch_dtype"] = torch.float32

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


def run_once(baseline, model_config, prompt, param_name, param_value, rep_index, output_path, hf_token):
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
        torch.set_num_interop_threads(max(1, threads // 2))

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

    prompt_text = stringify_prompt(prompt["messages"])
    batch_size = int(config.get("batch-size", "1"))
    ubatch_size = int(config.get("ubatch-size", str(batch_size)))
    if ubatch_size > batch_size:
        raise RuntimeError(f"ubatch-size {ubatch_size} must be <= batch-size {batch_size}")
    ctx_size = int(config.get("ctx_size", "0") or 0)

    prompt_texts = [prompt_text] * batch_size
    tokenizer_kwargs = dict(return_tensors="pt", padding=True)
    if ctx_size > 0:
        tokenizer_kwargs["truncation"] = True
        tokenizer_kwargs["max_length"] = ctx_size
    inputs = tokenizer(prompt_texts, **tokenizer_kwargs)
    input_ids = inputs.input_ids.to(model.device)
    attention_mask = inputs.attention_mask.to(model.device) if hasattr(inputs, "attention_mask") else None
    if attention_mask is not None:
        prompt_tokens_per_seq = attention_mask.sum(dim=1)
        prompt_tokens = int(prompt_tokens_per_seq.sum().item())
        max_prompt_len = int(prompt_tokens_per_seq.max().item())
    else:
        prompt_tokens = int(input_ids.numel())
        max_prompt_len = int(input_ids.shape[1])

    max_new_tokens = int(config.get("n_predict", "256"))
    if ctx_size > 0:
        max_new_tokens = min(max_new_tokens, max(ctx_size - max_prompt_len, 0))

    # Transformers TextStreamer only supports batch size 1. We approximate TTFT
    # with a single forward pass and use generate() for throughput per micro-batch.
    log(
        f"Running forward pass: batch={batch_size} ubatch={ubatch_size} "
        f"promptTokens={prompt_tokens} maxNew={max_new_tokens}"
    )
    first_token_ms = None
    with torch.no_grad():
        ttft_start = time.time()
        _ = model(input_ids=input_ids, attention_mask=attention_mask)
        first_token_ms = (time.time() - ttft_start) * 1000.0
    log(f"Forward pass complete (TTFT={first_token_ms:.1f}ms)")

    total_generated_tokens = 0
    output_text = ""

    batches = []
    for start in range(0, batch_size, ubatch_size):
        end = min(start + ubatch_size, batch_size)
        batch_input_ids = input_ids[start:end]
        batch_attention_mask = attention_mask[start:end] if attention_mask is not None else None
        batches.append((batch_input_ids, batch_attention_mask))

    gen_start = time.time()
    for batch_index, (batch_input_ids, batch_attention_mask) in enumerate(batches, start=1):
        log(f"Generating batch {batch_index}/{len(batches)}")
        generated = model.generate(
            input_ids=batch_input_ids,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            use_cache=True,
            attention_mask=batch_attention_mask if batch_attention_mask is not None else None,
        )
        generated_len = int(generated.shape[1])
        input_len = int(batch_input_ids.shape[1])
        total_generated_tokens += (generated_len - input_len) * batch_input_ids.shape[0]
        if not output_text:
            output_text = tokenizer.decode(
                generated[0][input_len:], skip_special_tokens=True
            )
    log("Generation complete")

    end_time = time.time()

    total_gen_time = max(end_time - gen_start, 1e-6)
    generation_time = max(total_gen_time - (first_token_ms / 1000.0 if first_token_ms else 0), 1e-6)
    tokens_after_first = max(total_generated_tokens - batch_size, 0)
    tps = tokens_after_first / generation_time
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
        "config": {**config, "quantization": model_variant, "modelId": model_config["id"]},
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
