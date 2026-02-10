import argparse
import json
import os
import time
import threading
from datetime import datetime

import psutil
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer
from transformers.utils import logging as hf_logging

hf_logging.set_verbosity_error()


def now_ms():
    return time.time() * 1000.0


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


def is_quantization_supported(quantization):
    platform = os.uname().sysname.lower() if hasattr(os, "uname") else ""
    if platform == "darwin" and quantization in ("bnb-4bit", "bnb-8bit"):
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


def load_torch_model(model_id, quantization, hf_token=None):
    kwargs = {"device_map": "auto"}
    if quantization == "bnb-4bit":
        kwargs["load_in_4bit"] = True
    elif quantization == "bnb-8bit":
        kwargs["load_in_8bit"] = True
    else:
        kwargs["dtype"] = torch.float16
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

    load_start = time.time()
    model, tokenizer = load_torch_model(model_id, quantization, hf_token=hf_token)
    model_load_ms = (time.time() - load_start) * 1000.0
    memory_load = capture_memory()

    prompt_text = stringify_prompt(prompt["messages"])
    inputs = tokenizer(prompt_text, return_tensors="pt")
    input_ids = inputs.input_ids.to(model.device)
    attention_mask = inputs.attention_mask.to(model.device) if hasattr(inputs, "attention_mask") else None
    prompt_tokens = input_ids.shape[-1]

    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True)
    max_new_tokens = int(config.get("n_predict", "256"))
    gen_kwargs = dict(input_ids=input_ids, max_new_tokens=max_new_tokens, streamer=streamer, do_sample=False)
    if attention_mask is not None:
        gen_kwargs["attention_mask"] = attention_mask

    start_time = time.time()
    first_token_ms = None
    output_chunks = []

    thread = threading.Thread(target=model.generate, kwargs=gen_kwargs)
    thread.start()
    for text in streamer:
        if first_token_ms is None:
            first_token_ms = (time.time() - start_time) * 1000.0
        output_chunks.append(text)
    thread.join()
    end_time = time.time()

    output_text = "".join(output_chunks)
    output_tokens = len(tokenizer(output_text).input_ids) if output_text else 0
    total_gen_time = max(end_time - start_time, 1e-6)
    generation_time = max(total_gen_time - (first_token_ms / 1000.0 if first_token_ms else 0), 1e-6)
    tokens_after_first = max(output_tokens - 1, 0)
    tps = tokens_after_first / generation_time

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


def main():
    args = parse_args()
    config = read_config(args.config)
    params_to_run = resolve_params_to_run(config, args.params)
    reps = args.reps if args.reps is not None else config["reps"]
    output_path = resolve_output_path(args.output, config["baseline"].get("modelId"))
    models_to_run = config.get("models", [])
    if len(models_to_run) == 0:
        raise SystemExit('perf-config.json must include at least one model in "models"')
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
                        if not is_quantization_supported(quantization):
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
