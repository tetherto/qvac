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
# `cpu_only` marks a leg with no usable GPU: the hosted arm64 runners have
# none, and macos-15-large is a VM whose Metal device reports as "Apple
# Paravirtual". Those legs still produce valid load-mode evidence — load_mode
# is about how weights reach memory, and the CPU backend is where the
# mapped-vs-anonymous residency split is widest — but they must be labelled
# CPU-forced rather than passed off as GPU measurements.
RUNNERS = {
    "linux-x64": {"runner": "qvac-ubuntu2204-x64-gpu"},
    "win32-x64": {"runner": "qvac-win25-x64-gpu"},
    "darwin-arm64": {"runner": '["self-hosted", "qvac-macos26-arm64-gpu"]'},
    "darwin-x64": {"runner": "macos-15-large", "cpu_only": "true"},
    "linux-arm64": {"runner": "ubuntu-22.04-arm", "cpu_only": "true"},
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
