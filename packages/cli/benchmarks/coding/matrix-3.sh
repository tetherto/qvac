#!/bin/sh
# The new harness (grep, edit feedback, read-only shell, plan-first) through the same CLI, same 15 exercises.
set -eu
cd "$(dirname "$0")/../.."
D=${QVAC_BENCH_DATA:-$HOME/.qvac/cli}
NEW=${QVAC_COMPARE_CLI:-$PWD}
M=Qwen3.6-35B-A3B-UD-Q4_K_M
R=output/bench/runs/matrix-3
common="--model $M --data-dir $D --languages python,go,rust,cpp,javascript --limit 15 --cli $NEW"
node benchmarks/coding/polyglot.mjs $common --reasoning plan                 --out $R/G-new-plan-project
node benchmarks/coding/polyglot.mjs $common --reasoning off                  --out $R/H-new-nothink-project
node benchmarks/coding/polyglot.mjs $common --reasoning plan --disable exec  --out $R/I-new-plan-project-noexec
