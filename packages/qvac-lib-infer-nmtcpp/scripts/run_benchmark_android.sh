#!/bin/bash
#
# Translation Benchmark & Evaluation Runner (Android/Termux)
# 
# Runs batch vs sequential comparison and reports performance metrics
#
# Usage:
#   ./scripts/run_benchmark_android.sh --model-path <path> [options]
#
# Required:
#   --model-path <path>   Path to model directory
#
# Examples:
#   ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/enit
#   ./scripts/run_benchmark_android.sh --model-path ./model/indictrans --model-type IndicTrans
#

set -e

# Defaults
MODEL_PATH=""
MODEL_TYPE="Bergamot"
SRC_LANG="en"
TGT_LANG="it"
MAX_SENTENCES="100"
FULL_DATASET=false
DATASET_PATH="./benchmarks/flores200_dataset"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --model-path)
      MODEL_PATH="$2"
      shift 2
      ;;
    --model-type|-t)
      MODEL_TYPE="$2"
      shift 2
      ;;
    --src-lang)
      SRC_LANG="$2"
      shift 2
      ;;
    --tgt-lang)
      TGT_LANG="$2"
      shift 2
      ;;
    --max)
      MAX_SENTENCES="$2"
      shift 2
      ;;
    --full)
      FULL_DATASET=true
      MAX_SENTENCES="0"
      shift
      ;;
    --dataset)
      DATASET_PATH="$2"
      shift 2
      ;;
    --help|-h)
      echo "Translation Benchmark & Evaluation Runner (Android/Termux)"
      echo ""
      echo "Usage: ./scripts/run_benchmark_android.sh --model-path <path> [options]"
      echo ""
      echo "Required:"
      echo "  --model-path <path>   Path to model directory"
      echo ""
      echo "Options:"
      echo "  --model-type, -t <type>   Bergamot or IndicTrans (default: Bergamot)"
      echo "  --src-lang <lang>     Source language (default: en)"
      echo "  --tgt-lang <lang>     Target language (default: it)"
      echo "  --max <n>             Max sentences (default: 100)"
      echo "  --full                Use full FLORES dataset (~1012 sentences)"
      echo "  --dataset <path>      Path to FLORES dataset (default: ./benchmarks/flores200_dataset)"
      echo "  --help                Show this help"
      echo ""
      echo "Examples:"
      echo "  # Bergamot model"
      echo "  ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/enit/2025-11-26"
      echo ""
      echo "  # IndicTrans model"
      echo "  ./scripts/run_benchmark_android.sh --model-path ./model/indictrans --model-type IndicTrans"
      echo ""
      echo "  # Full FLORES evaluation"
      echo "  ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/enit/2025-11-26 --full"
      echo ""
      echo "Quick Reference:"
      echo "┌─────────────────────┬────────────────────────────────────────────────────────────────────────────┐"
      echo "│ Variant             │ Command                                                                    │"
      echo "├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤"
      echo "│ Bergamot quick      │ ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/enit/... │"
      echo "│ Bergamot full       │ ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/... --full│"
      echo "│ IndicTrans quick     │ ./scripts/run_benchmark_android.sh --model-path ./model/indictrans -t IndicTrans│"
      echo "│ IndicTrans full      │ ./scripts/run_benchmark_android.sh --model-path ./model/indictrans -t IndicTrans --full│"
      echo "└─────────────────────┴────────────────────────────────────────────────────────────────────────────┘"
      echo ""
      echo "Results saved to: benchmark_results_js/"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage"
      exit 1
      ;;
  esac
done

# Determine project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Check required arguments
if [ -z "$MODEL_PATH" ]; then
  echo "❌ Error: --model-path is required"
  echo ""
  echo "Usage: ./scripts/run_benchmark_android.sh --model-path <path> [options]"
  echo ""
  echo "Examples:"
  echo "  ./scripts/run_benchmark_android.sh --model-path ./model/bergamot/enit/2025-11-26"
  echo "  ./scripts/run_benchmark_android.sh --model-path ./model/indictrans --model-type IndicTrans"
  echo ""
  echo "Use --help for more options"
  exit 1
fi

# Check model exists
if [ ! -d "$MODEL_PATH" ]; then
  echo "❌ Model not found: $MODEL_PATH"
  echo ""
  echo "Please provide a valid path to a model directory."
  exit 1
fi

# Print header
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           Translation Benchmark & Evaluation                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Configuration:"
echo "  Model type:    $MODEL_TYPE"
echo "  Model path:    $MODEL_PATH"
echo "  Languages:     $SRC_LANG → $TGT_LANG"
echo "  Dataset:       $DATASET_PATH"
if [ "$FULL_DATASET" = true ]; then
  echo "  Mode:          Full FLORES devtest"
else
  echo "  Max sentences: $MAX_SENTENCES"
fi
echo ""

# Build common args
COMMON_ARGS="--model-path $MODEL_PATH --model-type $MODEL_TYPE --src-lang $SRC_LANG --tgt-lang $TGT_LANG --dataset $DATASET_PATH"
if [ "$MAX_SENTENCES" != "0" ]; then
  COMMON_ARGS="$COMMON_ARGS --max $MAX_SENTENCES"
fi

# Create results directory
RESULTS_DIR="$REPO_ROOT/benchmark_results_js"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="$RESULTS_DIR/${MODEL_TYPE}_${SRC_LANG}-${TGT_LANG}_${TIMESTAMP}.txt"

# Run batch benchmark
echo "═══════════════════════════════════════════════════════════════"
echo "  [1/2] Running BATCH mode..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Run batch with real-time output
BATCH_LOG="$RESULTS_DIR/batch_temp_$$.log"
bare benchmarks/evaluate-bare.js $COMMON_ARGS 2>&1 | tee "$BATCH_LOG"
BATCH_OUTPUT=$(cat "$BATCH_LOG")
rm -f "$BATCH_LOG"

# Extract batch metrics
BATCH_SENTENCES=$(echo "$BATCH_OUTPUT" | grep "^Sentences:" | awk '{print $2}')
BATCH_TOKENS_SEC=$(echo "$BATCH_OUTPUT" | grep "Tokens/sec:" | awk '{print $2}')
BATCH_MS_SENT=$(echo "$BATCH_OUTPUT" | grep "Ms/sentence:" | awk '{print $2}')
BATCH_BLEU=$(echo "$BATCH_OUTPUT" | grep "Average BLEU:" | awk '{print $3}')
BATCH_TIME=$(echo "$BATCH_OUTPUT" | grep "Translate time:" | awk '{print $3}' | tr -d 'ms')

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  [2/2] Running SEQUENTIAL mode..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Run sequential with real-time output (using tee to capture and display)
SEQ_LOG="$RESULTS_DIR/seq_temp_$$.log"
bare benchmarks/evaluate-bare.js $COMMON_ARGS --sequential 2>&1 | tee "$SEQ_LOG"
SEQ_OUTPUT=$(cat "$SEQ_LOG")
rm -f "$SEQ_LOG"

# Extract sequential metrics
SEQ_TOKENS_SEC=$(echo "$SEQ_OUTPUT" | grep "Tokens/sec:" | awk '{print $2}')
SEQ_MS_SENT=$(echo "$SEQ_OUTPUT" | grep "Ms/sentence:" | awk '{print $2}')
SEQ_BLEU=$(echo "$SEQ_OUTPUT" | grep "Average BLEU:" | awk '{print $3}')
SEQ_TIME=$(echo "$SEQ_OUTPUT" | grep "Translate time:" | awk '{print $3}' | tr -d 'ms')

# Calculate speedup (using awk instead of bc for better compatibility)
if [ -n "$SEQ_TIME" ] && [ -n "$BATCH_TIME" ] && [ "$BATCH_TIME" != "0" ]; then
  SPEEDUP=$(awk "BEGIN {printf \"%.2f\", $SEQ_TIME / $BATCH_TIME}" 2>/dev/null || echo "N/A")
else
  SPEEDUP="N/A"
fi

# Print comparison
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    BENCHMARK RESULTS                         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Model: $MODEL_TYPE ($SRC_LANG → $TGT_LANG)"
echo "Path:  $MODEL_PATH"
echo "Sentences: ${BATCH_SENTENCES:-N/A}"
echo ""
echo "┌─────────────────┬──────────────┬──────────────┐"
echo "│ Metric          │ Batch        │ Sequential   │"
echo "├─────────────────┼──────────────┼──────────────┤"
printf "│ %-15s │ %12s │ %12s │\n" "Tokens/sec" "${BATCH_TOKENS_SEC:-N/A}" "${SEQ_TOKENS_SEC:-N/A}"
printf "│ %-15s │ %12s │ %12s │\n" "Ms/sentence" "${BATCH_MS_SENT:-N/A}" "${SEQ_MS_SENT:-N/A}"
printf "│ %-15s │ %12s │ %12s │\n" "Total time (ms)" "${BATCH_TIME:-N/A}" "${SEQ_TIME:-N/A}"
printf "│ %-15s │ %12s │ %12s │\n" "BLEU score" "${BATCH_BLEU:-N/A}" "${SEQ_BLEU:-N/A}"
echo "└─────────────────┴──────────────┴──────────────┘"
echo ""
echo "📊 Speedup (Batch vs Sequential): ${SPEEDUP}x"
echo ""

# Save results
{
  echo "Translation Benchmark Results"
  echo "============================="
  echo ""
  echo "Date:       $(date)"
  echo "Model:      $MODEL_TYPE"
  echo "Path:       $MODEL_PATH"
  echo "Languages:  $SRC_LANG → $TGT_LANG"
  echo "Sentences:  ${BATCH_SENTENCES:-N/A}"
  echo ""
  echo "BATCH MODE"
  echo "  Tokens/sec:   $BATCH_TOKENS_SEC"
  echo "  Ms/sentence:  $BATCH_MS_SENT"
  echo "  Total time:   ${BATCH_TIME}ms"
  echo "  BLEU:         $BATCH_BLEU"
  echo ""
  echo "SEQUENTIAL MODE"
  echo "  Tokens/sec:   $SEQ_TOKENS_SEC"
  echo "  Ms/sentence:  $SEQ_MS_SENT"
  echo "  Total time:   ${SEQ_TIME}ms"
  echo "  BLEU:         $SEQ_BLEU"
  echo ""
  echo "SPEEDUP: ${SPEEDUP}x"
} > "$RESULT_FILE"

echo "📁 Results saved to: $RESULT_FILE"
echo ""
echo "✅ Benchmark complete!"

