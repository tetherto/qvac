#!/usr/bin/env python3
"""Manual packaged-addon GPU run. No published addon or optional fixture skips."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

NATIVE_SHA = "84b02694001cfea863167776dbc185474a816656"
FAMILIES = {"tts": "tts-q8_0", "ttsd": "ttsd-q8_0", "sfx": "sfx-q8_0",
            "speech": "speech-q8_0", "transcribe": "transcribe-q5_0"}


def validate_tap(text, count):
    if not re.search(rf"^# tests = {count}/{count} pass$", text, re.M):
        raise RuntimeError(f"Expected {count}/{count} passing tests")
    if not re.search(r"^# ok$", text, re.M):
        raise RuntimeError("Missing successful test completion")
    if re.search(r"^not ok\b|^\s*ok\b[^\n]*\bskipping\b|#\s*SKIP\b(?!\s*=\s*0\b)|^# skip\s*=\s*[1-9]", text, re.M | re.I):
        raise RuntimeError("Skipped or failed case in strict GPU validation")


def native_tools(root):
    native = root / ".moss-native"
    sha = subprocess.check_output(["git", "-C", str(native), "rev-parse", "HEAD"], text=True).strip()
    if sha != NATIVE_SHA:
        raise RuntimeError("Native staging tools must match the pinned speech source")
    spec = importlib.util.spec_from_file_location("native_moss", native / "scripts/ci/moss-gpu-e2e.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return native, module


def stage(root, output, native, tools):
    # prepare_checkpoint derives TTS/TTSD q8_0 from F16 using the native
    # blk.-only quantizer, hashes both and removes the intermediate F16.
    # No F16/BF16 backbone is passed to addon inference.
    os.chdir(native)
    for family, case in FAMILIES.items():
        directory = root / ".moss-models" / ("tts" if family == "ttsd" else family)
        directory.mkdir(parents=True, exist_ok=True)
        family_output = output / family
        family_output.mkdir(exist_ok=True)
        tools.prepare_checkpoint(case, directory, family_output)
    for name in ["moss-codec-decoder-f16", "moss-codec-encoder-f16"]:
        tools.download(name, root / ".moss-models/tts", output)
    tools.download("moss-speech-codec-f16", root / ".moss-models/speech", output)
    for relative in ["packages/tts-ggml/test/reference-audio/jfk.wav",
                     "packages/asr-ggml/examples/samples/LastQuestion_long_ES.raw"]:
        fixture = root / relative
        if not fixture.is_file() or fixture.stat().st_size == 0:
            raise RuntimeError(f"Required audio fixture missing: {relative}")
        tools.record_model_hash(fixture, relative, output)


def run_backend(root, output, tools, backend):
    env = dict(os.environ, NO_GPU="false", QVAC_TEST_MOSS_FULL_GPU="true",
               TTS_CPP_GPU_BACKEND=backend, QVAC_TEST_MOSS_TRANSCRIBE_BACKEND=backend,
               QVAC_TEST_MOSS_MODEL_DIR=str(root / ".moss-models/tts"),
               QVAC_TEST_MOSS_SFX_MODEL_DIR=str(root / ".moss-models/sfx"),
               QVAC_TEST_MOSS_SPEECH_MODEL_DIR=str(root / ".moss-models/speech"),
               QVAC_TEST_MOSS_TRANSCRIBE_GGUF=str(root / ".moss-models/transcribe/moss-transcribe-diarize-q5_0.gguf"),
               INTEGRATION_TEST_TIMEOUT="1800")
    suites = [
        ("tts", "tts-ggml", ["npx", "--no-install", "brittle-bare",
         "test/integration/moss.test.js", "test/integration/moss-speech.test.js"], 12, 10800),
        ("sfx", "tts-ggml", ["npx", "--no-install", "brittle-bare",
         "test/integration/moss-sfx.test.js"], 2, 5400),
        ("transcribe", "asr-ggml", ["bash", "test/integration/parakeet-run-tests.sh"], 1, 1860),
    ]
    # Generate ONLY the MOSS entrypoint. The existing Bare exit wrapper then
    # handles native event-loop teardown without pulling in broad ASR cases.
    subprocess.run(["npx", "--no-install", "brittle", "-r", "test/integration/all.js",
                    "test/integration/moss-transcribe.test.js"],
                   cwd=root / "packages/asr-ggml", env=env, check=True, timeout=60)
    results = []
    for name, package, command, count, timeout in suites:
        label = f"{backend}-{name}"
        log = output / f"{label}.log"
        result = {"backend": backend, "suite": name, "expected_tests": count, "command": command}
        try:
            with tools.gpu_lease(output, label):
                tools.gpu_snapshot(output, label, "before")
                with log.open("w") as stream:
                    # GNU timeout kills the process group, including Bare children.
                    process = subprocess.run(["timeout", "--kill-after=30", str(timeout), *command],
                                             cwd=root / "packages" / package, env=env,
                                             stdout=stream, stderr=subprocess.STDOUT, check=False)
                result["exit_code"] = process.returncode
                if process.returncode:
                    raise RuntimeError(f"{label}: exit {process.returncode}")
                validate_tap(log.read_text(), count)
                tools.gpu_snapshot(output, label, "after")
            result["status"] = "passed"
        except Exception as error:
            result.update(status="failed", error=str(error))
        finally:
            if log.exists():
                print(log.read_text()[-24000:], flush=True)
            results.append(result)
            (output / f"{backend}-results.json").write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(result), flush=True)
    if any(result["status"] != "passed" for result in results):
        raise RuntimeError(f"{backend}: packaged addon validation failed; see suite logs")


def main():
    root = Path(__file__).resolve().parents[2]
    output = root / "moss-packaged-results"
    output.mkdir(exist_ok=True)
    native, tools = native_tools(root)
    mode = sys.argv[1]
    if mode == "stage":
        stage(root, output, native, tools)
    elif mode in {"cuda", "vulkan"}:
        run_backend(root, output, tools, mode)
    else:
        raise ValueError("Expected stage, cuda or vulkan")


if __name__ == "__main__":
    main()
