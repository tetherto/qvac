#!/bin/sh
# All 225 polyglot exercises on the Mac, harness dev 599bae9e (nudge + sandbox writable): thinking off, then plan.
set -eu
cd "$(dirname "$0")/../.."
export PATH=$HOME/.nvm/versions/node/v24.11.0/bin:$PATH
D=${QVAC_BENCH_DATA:-$HOME/.qvac/cli}
M=Qwen3.6-35B-A3B-UD-Q4_K_M
R=output/bench/runs/matrix-5
common="--model $M --data-dir $D --languages cpp,go,java,javascript,python,rust --disable exec"
node benchmarks/coding/polyglot.mjs $common --reasoning off  --out $R/L-full-nothink
node benchmarks/coding/polyglot.mjs $common --reasoning plan --out $R/M-full-plan
echo MATRIX5_DONE
