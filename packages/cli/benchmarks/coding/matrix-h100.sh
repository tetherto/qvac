#!/bin/sh
# Matrices 2-4 on the H100, after a run D baseline there; same 15 exercises as the Mac.
set -eu
cd "$(dirname "$0")/../.."
# @qvac/fabric-linux-x64 0.22.0's CUDA backend uses libstdc++ without linking it, and bare-sidecar has none
export LD_PRELOAD=/lib/x86_64-linux-gnu/libstdc++.so.6
D=${QVAC_BENCH_DATA:-$HOME/.qvac/cli}
M=Qwen3.6-35B-A3B-UD-Q4_K_M
R=output/bench/runs/h100
common="--model $M --data-dir $D --languages python,go,rust,cpp,javascript --limit 15"
node benchmarks/coding/polyglot.mjs $common --reasoning off --disable exec                 --out $R/D-nothink-project-noexec
node benchmarks/coding/polyglot.mjs $common --reasoning on --budget 1024 --disable exec    --out $R/E-think1024-project-noexec
node benchmarks/coding/polyglot.mjs $common --reasoning on --budget 256  --disable exec    --out $R/F-think256-project-noexec
node benchmarks/coding/polyglot.mjs $common --cli "${QVAC_COMPARE_CLI:-$PWD}" --reasoning plan              --out $R/G-new-plan-project
node benchmarks/coding/polyglot.mjs $common --cli "${QVAC_COMPARE_CLI:-$PWD}" --reasoning off               --out $R/H-new-nothink-project
node benchmarks/coding/polyglot.mjs $common --cli "${QVAC_COMPARE_CLI:-$PWD}" --reasoning plan --disable exec --out $R/I-new-plan-project-noexec
node benchmarks/coding/polyglot.mjs $common --cli "${QVAC_COMPARE_CLI:-$PWD}" --reasoning plan --disable exec --out $R/J-new-plan-instructions
node benchmarks/coding/polyglot.mjs $common --cli "${QVAC_COMPARE_CLI:-$PWD}" --reasoning off  --disable exec --out $R/K-new-nothink-instructions
echo MATRIX_DONE
