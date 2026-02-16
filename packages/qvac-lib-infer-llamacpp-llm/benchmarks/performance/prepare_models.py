#!/usr/bin/env python3
"""
Shared model preparation utility for benchmark runners.

Current capabilities:
- addon target: downloads GGUF files listed in models.manifest.json (if missing)
- pytorch target: placeholder (intentionally does nothing for now)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _parse_args() -> argparse.Namespace:
    script_dir = pathlib.Path(__file__).resolve().parent

    parser = argparse.ArgumentParser(description="Prepare benchmark models for addon and pytorch runners.")
    parser.add_argument(
        "--manifest",
        default=str(script_dir / "models.manifest.json"),
        help="Path to shared model manifest JSON"
    )
    parser.add_argument(
        "--target",
        default="addon",
        choices=["addon", "pytorch", "all"],
        help="Which target to prepare"
    )
    parser.add_argument(
        "--models",
        default="",
        help="Optional comma-separated model IDs to prepare"
    )
    parser.add_argument(
        "--models-dir",
        default=str((script_dir / ".." / ".." / "test" / "model").resolve()),
        help="Directory to store addon GGUF model files"
    )
    parser.add_argument(
        "--output",
        default=str(script_dir / "resolved-models.json"),
        help="Output file with resolved local model paths and metadata"
    )
    return parser.parse_args()


def _load_manifest(path: pathlib.Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Manifest not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if "models" not in data or not isinstance(data["models"], list):
        raise ValueError("Invalid manifest: expected top-level 'models' array")
    return data


def _select_models(models: list[dict[str, Any]], selected_ids: set[str]) -> list[dict[str, Any]]:
    if not selected_ids:
        return models
    selected = [m for m in models if m.get("id") in selected_ids]
    missing = sorted(selected_ids - {m.get("id") for m in selected})
    if missing:
        raise ValueError(f"Unknown model IDs in --models: {', '.join(missing)}")
    return selected


def _download_file(url: str, destination: pathlib.Path, hf_token: str | None) -> None:
    headers = {"User-Agent": "qvac-benchmark-model-prep/1.0"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    request = urllib.request.Request(url, headers=headers, method="GET")
    destination.parent.mkdir(parents=True, exist_ok=True)

    tmp_path = destination.with_suffix(destination.suffix + ".partial")
    with urllib.request.urlopen(request) as response, tmp_path.open("wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    tmp_path.replace(destination)


def _list_repo_gguf_files(repo: str, revision: str, hf_token: str | None) -> list[str]:
    encoded_repo = urllib.parse.quote(repo, safe="")
    api_url = f"https://huggingface.co/api/models/{encoded_repo}?revision={urllib.parse.quote(revision, safe='')}"
    headers = {"User-Agent": "qvac-benchmark-model-prep/1.0"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    request = urllib.request.Request(api_url, headers=headers, method="GET")
    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read().decode("utf-8"))

    siblings = payload.get("siblings") or []
    return [x.get("rfilename") for x in siblings if isinstance(x, dict) and str(x.get("rfilename", "")).endswith(".gguf")]


def _normalize_token(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def _quantization_patterns(quantization: str) -> list[str]:
    q = quantization.upper()
    patterns = [q.lower()]
    if q == "F16":
        patterns.extend(["f16", "fp16"])
    elif q == "F32":
        patterns.extend(["f32", "fp32"])
    elif q == "Q8_0":
        patterns.extend(["q8_0", "q8-0", "q8.0", "q80"])
    elif q == "Q4_0":
        patterns.extend(["q4_0", "q4-0", "q4.0", "q40"])
    elif q == "Q4_K_M":
        patterns.extend(["q4_k_m", "q4-k-m", "q4km"])
    return list(dict.fromkeys(patterns))


def _resolve_gguf_filename(repo: str, revision: str, requested_filename: str, quantization: str, hf_token: str | None) -> str:
    gguf_files = _list_repo_gguf_files(repo, revision, hf_token)
    if not gguf_files:
        raise RuntimeError(f"No GGUF files found in Hugging Face repo {repo}@{revision}")

    requested_basename = os.path.basename(requested_filename)
    requested_lower = requested_basename.lower()
    for candidate in gguf_files:
        if os.path.basename(candidate).lower() == requested_lower:
            return candidate

    expected_norm = _normalize_token(requested_basename)
    for candidate in gguf_files:
        if _normalize_token(os.path.basename(candidate)) == expected_norm:
            return candidate

    patterns = _quantization_patterns(quantization)
    pattern_matches = []
    for candidate in gguf_files:
        lower = os.path.basename(candidate).lower()
        if any(pattern in lower for pattern in patterns):
            pattern_matches.append(candidate)

    if len(pattern_matches) == 1:
        return pattern_matches[0]

    if len(pattern_matches) > 1:
        raise RuntimeError(
            f"Ambiguous GGUF matches for quantization {quantization} in {repo}@{revision}: {pattern_matches}. "
            "Please pin exact filename in manifest."
        )

    raise RuntimeError(
        f"No matching GGUF file found for requested='{requested_basename}' quantization='{quantization}' in "
        f"{repo}@{revision}. Available files: {gguf_files}"
    )


def _prepare_addon_models(selected_models: list[dict[str, Any]], models_dir: pathlib.Path, hf_token: str | None) -> dict[str, Any]:
    resolved: dict[str, Any] = {}
    models_dir.mkdir(parents=True, exist_ok=True)

    for model in selected_models:
        model_id = model["id"]
        gguf = model.get("gguf") or {}
        repo = gguf.get("repo")
        revision = gguf.get("revision", "main")
        files = gguf.get("files") or {}
        default_quant = gguf.get("defaultQuantization")

        if not repo:
            raise ValueError(f"Manifest model {model_id} missing gguf.repo")
        if not isinstance(files, dict) or not files:
            raise ValueError(f"Manifest model {model_id} missing gguf.files mapping")

        quant_files: dict[str, str] = {}
        for quantization, filename in files.items():
            requested_destination = models_dir / filename
            if requested_destination.exists():
                quant_files[quantization] = str(requested_destination)
                print(f"[addon] {model_id}:{quantization} already present -> {requested_destination}")
                continue

            selected_filename = filename
            destination = requested_destination
            url = f"https://huggingface.co/{repo}/resolve/{revision}/{selected_filename}"
            print(f"[addon] downloading {model_id}:{quantization} from {url}")
            try:
                _download_file(url, destination, hf_token)
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise RuntimeError(f"Failed download for {model_id}:{quantization} ({url}): HTTP {e.code}") from e

                selected_filename = _resolve_gguf_filename(repo, revision, filename, quantization, hf_token)
                destination = models_dir / os.path.basename(selected_filename)
                url = f"https://huggingface.co/{repo}/resolve/{revision}/{selected_filename}"
                print(f"[addon] retrying with resolved filename {selected_filename}")
                _download_file(url, destination, hf_token)
            except urllib.error.URLError as e:
                raise RuntimeError(f"Failed download for {model_id}:{quantization} ({url}): {e}") from e

            quant_files[quantization] = str(destination)

        resolved[model_id] = {
            "gguf": {
                "repo": repo,
                "revision": revision,
                "defaultQuantization": default_quant,
                "files": quant_files
            }
        }

    return resolved


def _prepare_pytorch_placeholder(selected_models: list[dict[str, Any]]) -> dict[str, Any]:
    print("[pytorch] placeholder active: no downloads performed yet.")
    resolved: dict[str, Any] = {}
    for model in selected_models:
        model_id = model["id"]
        pytorch = model.get("pytorch") or {}
        resolved[model_id] = {
            "pytorch": {
                "repo": pytorch.get("repo"),
                "revision": pytorch.get("revision", "main"),
                "status": "placeholder"
            }
        }
    return resolved


def main() -> int:
    args = _parse_args()
    manifest_path = pathlib.Path(args.manifest).resolve()
    output_path = pathlib.Path(args.output).resolve()
    models_dir = pathlib.Path(args.models_dir).resolve()
    selected_ids = {x.strip() for x in args.models.split(",") if x.strip()}
    hf_token = os.getenv("HF_TOKEN")

    manifest = _load_manifest(manifest_path)
    selected_models = _select_models(manifest["models"], selected_ids)

    resolved: dict[str, Any] = {
        "manifestPath": str(manifest_path),
        "modelsDir": str(models_dir),
        "target": args.target,
        "models": {}
    }

    if args.target in ("addon", "all"):
        addon_models = _prepare_addon_models(selected_models, models_dir, hf_token)
        for model_id, payload in addon_models.items():
            resolved["models"].setdefault(model_id, {}).update(payload)

    if args.target in ("pytorch", "all"):
        pytorch_models = _prepare_pytorch_placeholder(selected_models)
        for model_id, payload in pytorch_models.items():
            resolved["models"].setdefault(model_id, {}).update(payload)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(resolved, indent=2) + "\n", encoding="utf-8")
    print(f"Resolved models written to: {output_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"prepare_models.py failed: {exc}", file=sys.stderr)
        raise
