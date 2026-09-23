#!/usr/bin/env python3
"""Emit the desktop benchmark matrix for benchmark-perf-llm-llamacpp.yml.

A real file rather than an inline heredoc: a heredoc inside a multi-line
`run:` block is invisible to YAML validation and to every local check, so a
malformed one only surfaces when the workflow runs. This is importable,
runnable and diffable.

Reads DESKTOP_PLATFORMS (a JSON array, default ["linux-x64"]) and writes a
`desktop_matrix=<json>` line for $GITHUB_OUTPUT.
"""

import json
import os
import sys

# Runner per desktop platform. The four QVAC-25043 names all resolve;
# linux-arm64 and darwin-x64 reuse the runners the LLM integration workflow
# already uses for them.
#
# No platform-level device forcing. A leg requests whatever device the sweep
# selects and the addon reports which backend actually ran, so a GPU request
# that silently falls back to CPU is recorded as a backend mismatch rather than
# published as GPU evidence. That is the safety mechanism; hardcoding CPU by
# platform name would instead quietly change what the requested matrix measures,
# and this task's whole question is what happens per platform AND device.
#
# Evidence, for whoever revisits this:
#   - ubuntu-22.04-arm genuinely has no GPU (integration-test-llm-llamacpp.yml
#     marks both ARM64 Ubuntu legs no_gpu, and turboquant.test.js identifies its
#     Vulkan backend as LLVMpipe software rendering).
#   - macos-15-large is NOT GPU-less: it exposes an Apple Paravirtual Metal
#     device. Other integration tests force CPU there because Metal is flaky for
#     THEM, which does not establish that a load-only benchmark cannot use it.
# Let the run answer it. `device=cpu` in sweep_params is how a dispatch asks for
# CPU measurements deliberately.
RUNNERS = {
    "linux-x64": {"runner": "qvac-ubuntu2204-x64-gpu"},
    "win32-x64": {"runner": "qvac-win25-x64-gpu"},
    "darwin-arm64": {"runner": '["self-hosted", "qvac-macos26-arm64-gpu"]'},
    "darwin-x64": {"runner": "macos-15-large"},
    "linux-arm64": {"runner": "ubuntu-22.04-arm"},
}


def plan(raw):
    requested = json.loads(raw or '["linux-x64"]')
    unknown = [p for p in requested if p not in RUNNERS]
    if unknown:
        raise SystemExit(
            f"Unknown desktop platform(s): {unknown}. Known: {sorted(RUNNERS)}"
        )
    if not requested:
        raise SystemExit("desktop_platforms is empty; at least one platform is required")
    return [dict(platform=p, **RUNNERS[p]) for p in requested]


def main():
    matrix = plan(os.environ.get("DESKTOP_PLATFORMS"))
    sys.stdout.write("desktop_matrix=" + json.dumps(matrix) + "\n")


if __name__ == "__main__":
    main()
