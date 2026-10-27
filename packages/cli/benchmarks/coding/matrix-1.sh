#!/bin/sh
# Qwen3.6-35B-A3B: thinking, the project line and the exec tool, one change at a time, same 15 exercises.
set -eu
cd "$(dirname "$0")/../.."
D=${QVAC_BENCH_DATA:-$HOME/.qvac/cli}
M=Qwen3.6-35B-A3B-UD-Q4_K_M
R=output/bench/runs/matrix-1
common="--model $M --data-dir $D --languages python,go,rust,cpp,javascript --limit 15"
node benchmarks/coding/polyglot.mjs $common --reasoning on  --plain               --out $R/A-think-plain
node benchmarks/coding/polyglot.mjs $common --reasoning off --plain               --out $R/B-nothink-plain
node benchmarks/coding/polyglot.mjs $common --reasoning off                       --out $R/C-nothink-project
node benchmarks/coding/polyglot.mjs $common --reasoning off --disable exec        --out $R/D-nothink-project-noexec
