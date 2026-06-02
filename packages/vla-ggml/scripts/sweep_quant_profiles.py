#!/usr/bin/env python3
"""π₀.₅ quantisation sweep — produce multiple GGUFs from one LeRobot
state-dict load, run each through the pi05 addon on the parity-oracle
fixture, collect end-to-end cos-sim vs PyTorch reference, write a
markdown report.

This is a development sweep tool, NOT the CI integration gate. The CI
gate is ``test/integration/pi05.test.js`` in ``qvac-pi05-impl`` — that
test asserts cos > 0.999 against a single GGUF. This driver invokes the
same test binary as a subprocess once per profile, parses the cos-sim
line out of its TAP output, and aggregates the results.

Usage:

    python3 scripts/sweep_quant_profiles.py \\
      --checkpoint lerobot/pi05_base \\
      --workdir    /tmp/pi05_sweep \\
      --profiles   f16,current,q8_broad,q5_mlp,q4_mlp_emb \\
      --pi05-impl  /path/to/qvac-pi05-impl \\
      --oracle-dump /path/to/qvac-parity-oracle/.../oracle_dump

Or, to skip conversion and re-run validation only:

    python3 scripts/sweep_quant_profiles.py --skip-conversion ...

Output: ``<workdir>/sweep_report.md`` plus per-profile
``pi05_base_<profile>.gguf`` files.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import convert_pi05_to_gguf as conv


log = logging.getLogger("pi05-sweep")


ALL_PROFILES = [
    # First sweep — broad baselines
    "f16", "current", "q8_broad", "q5_mlp", "q4_mlp_emb",
    # Diagnostic sweep — one knob off q8_broad each
    "q8b_q5_embed", "q8b_q4_embed", "q8b_q5_vision",
    "q8b_q8_expert", "q8b_q5_vlm_attn", "q8b_q5_mlp_mid",
    # Final stacked candidate
    "q_aggressive",
]


@dataclass
class SweepResult:
    profile: str
    gguf_path: Path
    gguf_size_bytes: int
    convert_seconds: float
    test_seconds: float
    cos_sim: float | None
    max_abs_diff: float | None
    rel_max: float | None
    max_abs_expected: float | None
    test_passed: bool
    notes: str


# The integration test logs one line per inference:
#   actions: cos=0.999123 max_abs_diff=0.001234 rel_max=0.012345 max_abs_expected=0.5432
_COS_RE = re.compile(
    r"cos=([-+0-9.eE]+)\s+"
    r"max_abs_diff=([-+0-9.eE]+)\s+"
    r"rel_max=([-+0-9.eE]+)\s+"
    r"max_abs_expected=([-+0-9.eE]+)"
)


def parse_cos_line(stdout: str) -> tuple[float, float, float, float] | None:
    """Pull the (cos, diff, rel, max) tuple from the first matching line."""
    for line in stdout.splitlines():
        m = _COS_RE.search(line)
        if m:
            return (float(m.group(1)), float(m.group(2)),
                    float(m.group(3)), float(m.group(4)))
    return None


def load_state_dict_once(args: argparse.Namespace) -> dict:
    """Load the LeRobot state dict a single time so all profiles share it."""
    if args.state_dict is not None:
        return conv.load_state_dict_from_safetensors(args.state_dict)
    if args.checkpoint is not None:
        return conv.load_state_dict_from_lerobot(args.checkpoint)
    if args.self_test:
        return conv.synthesize_state_dict()
    raise ValueError("need one of --checkpoint, --state-dict, --self-test")


def convert_profile(
    sd: dict, profile: str, out_path: Path, source_label: str
) -> tuple[int, float]:
    """Convert the shared state dict to a profile-specific GGUF."""
    t0 = time.time()
    n_written, _intended = conv.convert(sd, out_path, source_label, profile)
    return n_written, time.time() - t0


def run_integration_test(
    pi05_impl_dir: Path, gguf_path: Path, fixture: Path, activations: Path,
    timeout_s: int,
) -> tuple[bool, float, str, str]:
    """Run ``bare test/integration/pi05.test.js`` against one GGUF.

    Returns (passed, elapsed_s, stdout, stderr). ``passed`` is true iff the
    process exited 0 — note that a profile below the cos > 0.999 bar will
    legitimately return false here, which is fine for the sweep.
    """
    env = {
        # Inherit the world (PATH, HOME, etc.) — but force the test
        # asset env vars to ours.
        **{k: v for k, v in __import__("os").environ.items()},
        "PI05_TEST_GGUF": str(gguf_path),
        "PI05_TEST_FIXTURE": str(fixture),
        "PI05_TEST_ACTIVATIONS": str(activations),
    }
    test_path = (pi05_impl_dir
                 / "packages/vla-ggml/test/integration/pi05.test.js")
    if not test_path.exists():
        raise FileNotFoundError(f"integration test not found at {test_path}")
    t0 = time.time()
    proc = subprocess.run(
        ["bare", str(test_path)],
        cwd=str(pi05_impl_dir / "packages/vla-ggml"),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    return proc.returncode == 0, time.time() - t0, proc.stdout, proc.stderr


def render_report(results: list[SweepResult], out_path: Path) -> None:
    """Write the per-profile sweep table to a markdown file."""
    lines: list[str] = []
    lines.append("# π₀.₅ quantisation sweep — end-to-end cos-sim report")
    lines.append("")
    lines.append("Generated by `sweep_quant_profiles.py`. Each row reports "
                 "the result of running `pi05.test.js` against the GGUF "
                 "produced by that quant profile, comparing the addon's "
                 "`actions_final` against the parity-oracle PyTorch "
                 "reference. Plan §5 bar for CPU end-to-end is "
                 "**cos > 0.999** and **rel_max < 0.05**.")
    lines.append("")
    lines.append("| Profile | GGUF MB | Convert s | Test s | cos | rel_max | max_abs_diff | gate |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|:---:|")
    for r in results:
        size_mb = r.gguf_size_bytes / 1e6 if r.gguf_size_bytes else 0
        if r.cos_sim is None:
            cos_str = "—"
            rel_str = "—"
            diff_str = "—"
        else:
            cos_str = f"{r.cos_sim:.6f}"
            rel_str = f"{r.rel_max:.4f}" if r.rel_max is not None else "—"
            diff_str = f"{r.max_abs_diff:.4f}" if r.max_abs_diff is not None else "—"
        passed_bar = (
            r.cos_sim is not None
            and r.cos_sim > 0.999
            and (r.rel_max or 1.0) < 0.05
        )
        gate = "✅" if passed_bar else "❌"
        if r.notes:
            gate += f" {r.notes}"
        lines.append(
            f"| `{r.profile}` | {size_mb:.0f} | {r.convert_seconds:.1f} | "
            f"{r.test_seconds:.1f} | {cos_str} | {rel_str} | {diff_str} | {gate} |"
        )
    lines.append("")
    lines.append("Bars from `plan.md §5`. `gate=✅` means both bars cleared; "
                 "`❌` means at least one missed (or the test crashed before "
                 "emitting the cos-sim line).")
    out_path.write_text("\n".join(lines) + "\n")
    log.info("wrote report → %s", out_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--checkpoint",
                     help="HF repo or local dir for LeRobot PI05Policy")
    src.add_argument("--state-dict", type=Path,
                     help="Path to a single safetensors state-dict file")
    src.add_argument("--self-test", action="store_true",
                     help="Use the synthesised all-zeros state dict — "
                          "cos-sim will be undefined, only structural.")

    parser.add_argument("--workdir", type=Path, required=True,
                        help="Where to write per-profile GGUFs + report")
    parser.add_argument("--profiles", default=",".join(ALL_PROFILES),
                        help="Comma-separated subset of: "
                             f"{','.join(ALL_PROFILES)}")
    parser.add_argument("--pi05-impl", type=Path, required=True,
                        help="Path to qvac-pi05-impl checkout (where "
                             "pi05.test.js + the built addon live)")
    parser.add_argument("--oracle-dump", type=Path, required=True,
                        help="Directory containing fixture.safetensors and "
                             "activations.safetensors (parity-oracle dump)")
    parser.add_argument("--skip-conversion", action="store_true",
                        help="Don't re-convert; reuse existing GGUFs in "
                             "workdir keyed by profile name")
    parser.add_argument("--skip-test", action="store_true",
                        help="Convert only; don't invoke the integration test")
    parser.add_argument("--test-timeout-s", type=int, default=600,
                        help="Per-profile timeout for bare pi05.test.js")
    parser.add_argument("--delete-gguf-after-test", action="store_true",
                        help="Free disk by deleting each per-profile GGUF "
                             "after its integration test finishes. Result "
                             "rows still record the GGUF size from before "
                             "deletion. Use when running many profiles "
                             "against limited disk.")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="[%(name)s] %(message)s",
    )

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    unknown = [p for p in profiles if p not in ALL_PROFILES]
    if unknown:
        log.error("unknown profile(s): %s; valid: %s", unknown, ALL_PROFILES)
        return 2

    fixture = args.oracle_dump / "fixture.safetensors"
    activations = args.oracle_dump / "activations.safetensors"
    for p in (fixture, activations):
        if not p.exists():
            log.error("oracle dump file missing: %s", p)
            return 2

    args.workdir.mkdir(parents=True, exist_ok=True)

    if args.skip_conversion:
        sd = None
        source_label = "(skipped)"
    else:
        log.info("loading state dict once for all profiles...")
        sd = load_state_dict_once(args)
        source_label = (
            args.checkpoint if args.checkpoint
            else str(args.state_dict) if args.state_dict
            else "synthetic"
        )
        log.info("loaded %d state-dict entries from %s",
                 len(sd), source_label)

    results: list[SweepResult] = []
    for profile in profiles:
        gguf_path = args.workdir / f"pi05_base_{profile}.gguf"
        notes_parts: list[str] = []

        if args.skip_conversion:
            if not gguf_path.exists():
                log.warning("[%s] skip-conversion set but GGUF missing at %s",
                            profile, gguf_path)
                results.append(SweepResult(
                    profile=profile, gguf_path=gguf_path, gguf_size_bytes=0,
                    convert_seconds=0.0, test_seconds=0.0,
                    cos_sim=None, max_abs_diff=None,
                    rel_max=None, max_abs_expected=None,
                    test_passed=False, notes="GGUF missing",
                ))
                continue
            convert_seconds = 0.0
            log.info("[%s] reusing existing GGUF (%.0f MB)",
                     profile, gguf_path.stat().st_size / 1e6)
        else:
            log.info("[%s] converting → %s", profile, gguf_path)
            try:
                _, convert_seconds = convert_profile(
                    sd, profile, gguf_path, source_label
                )
                log.info("[%s] convert OK in %.1f s (%.0f MB)",
                         profile, convert_seconds,
                         gguf_path.stat().st_size / 1e6)
            except Exception as e:
                log.error("[%s] convert failed: %s", profile, e)
                results.append(SweepResult(
                    profile=profile, gguf_path=gguf_path, gguf_size_bytes=0,
                    convert_seconds=0.0, test_seconds=0.0,
                    cos_sim=None, max_abs_diff=None,
                    rel_max=None, max_abs_expected=None,
                    test_passed=False,
                    notes=f"convert error: {type(e).__name__}",
                ))
                continue

        size_bytes = gguf_path.stat().st_size

        if args.skip_test:
            results.append(SweepResult(
                profile=profile, gguf_path=gguf_path,
                gguf_size_bytes=size_bytes,
                convert_seconds=convert_seconds, test_seconds=0.0,
                cos_sim=None, max_abs_diff=None,
                rel_max=None, max_abs_expected=None,
                test_passed=False, notes="test skipped",
            ))
            continue

        log.info("[%s] running pi05.test.js...", profile)
        try:
            passed, test_seconds, stdout, stderr = run_integration_test(
                args.pi05_impl, gguf_path, fixture, activations,
                args.test_timeout_s,
            )
        except subprocess.TimeoutExpired:
            log.error("[%s] test timed out", profile)
            results.append(SweepResult(
                profile=profile, gguf_path=gguf_path,
                gguf_size_bytes=size_bytes,
                convert_seconds=convert_seconds, test_seconds=float(args.test_timeout_s),
                cos_sim=None, max_abs_diff=None,
                rel_max=None, max_abs_expected=None,
                test_passed=False, notes="timeout",
            ))
            continue
        except Exception as e:
            log.error("[%s] test crashed: %s", profile, e)
            results.append(SweepResult(
                profile=profile, gguf_path=gguf_path,
                gguf_size_bytes=size_bytes,
                convert_seconds=convert_seconds, test_seconds=0.0,
                cos_sim=None, max_abs_diff=None,
                rel_max=None, max_abs_expected=None,
                test_passed=False, notes=f"crash: {type(e).__name__}",
            ))
            continue

        parsed = parse_cos_line(stdout)
        if parsed is None:
            log.warning("[%s] could not parse cos-sim line from stdout",
                        profile)
            notes_parts.append("no cos line")
        cos, diff, rel, mx = parsed if parsed else (None, None, None, None)

        # Persist per-profile raw logs so failures are debuggable.
        (args.workdir / f"pi05_base_{profile}.stdout.log").write_text(stdout)
        (args.workdir / f"pi05_base_{profile}.stderr.log").write_text(stderr)

        results.append(SweepResult(
            profile=profile, gguf_path=gguf_path,
            gguf_size_bytes=size_bytes,
            convert_seconds=convert_seconds, test_seconds=test_seconds,
            cos_sim=cos, max_abs_diff=diff, rel_max=rel,
            max_abs_expected=mx,
            test_passed=passed,
            notes="; ".join(notes_parts),
        ))
        log.info("[%s] cos=%s rel_max=%s passed=%s",
                 profile,
                 f"{cos:.6f}" if cos is not None else "—",
                 f"{rel:.4f}" if rel is not None else "—",
                 passed)

        if args.delete_gguf_after_test and gguf_path.exists():
            gguf_path.unlink()
            log.info("[%s] deleted GGUF (--delete-gguf-after-test)", profile)

    report_path = args.workdir / "sweep_report.md"
    render_report(results, report_path)
    # Also dump structured JSON so the CI / downstream tools can read it
    # without parsing markdown.
    json_path = args.workdir / "sweep_report.json"
    json_path.write_text(json.dumps([
        {
            "profile": r.profile,
            "gguf_path": str(r.gguf_path),
            "gguf_size_bytes": r.gguf_size_bytes,
            "convert_seconds": r.convert_seconds,
            "test_seconds": r.test_seconds,
            "cos_sim": r.cos_sim,
            "max_abs_diff": r.max_abs_diff,
            "rel_max": r.rel_max,
            "max_abs_expected": r.max_abs_expected,
            "test_passed": r.test_passed,
            "notes": r.notes,
        }
        for r in results
    ], indent=2))
    log.info("wrote JSON → %s", json_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
