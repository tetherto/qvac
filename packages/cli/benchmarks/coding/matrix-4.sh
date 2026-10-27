#!/bin/sh
# matrix-3's harness plus the Aider-style instruction lines, same 15 exercises.
set -eu
cd "$(dirname "$0")/../.."
D=${QVAC_BENCH_DATA:-$HOME/.qvac/cli}
NEW=${QVAC_COMPARE_CLI:-$PWD}
M=Qwen3.6-35B-A3B-UD-Q4_K_M
R=output/bench/runs/matrix-4
common="--model $M --data-dir $D --languages python,go,rust,cpp,javascript --limit 15 --cli $NEW --disable exec"
node benchmarks/coding/polyglot.mjs $common --reasoning plan --out $R/J-new-plan-instructions
node benchmarks/coding/polyglot.mjs $common --reasoning off  --out $R/K-new-nothink-instructions
