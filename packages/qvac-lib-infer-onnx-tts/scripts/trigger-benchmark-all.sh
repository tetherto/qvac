#!/bin/bash

# Script to trigger benchmark workflow for all supported languages
# Usage: ./scripts/trigger-benchmark-all.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# All supported languages (base codes, except en-us which keeps locale)
LANGUAGES=(
    "en-us"
    "ar"
    "bg"
    "ca"
    "cs"
    "cy"
    "da"
    "de"
    "el"
    "es"
    "fa"
    "fi"
    "fr"
    "hi"
    "hu"
    "id"
    "is"
    "it"
    "ka"
    "kk"
    "lb"
    "lv"
    "ml"
    "ne"
    "nl"
    "no"
    "pl"
    "pt"
    "ro"
    "ru"
    "sk"
    "sl"
    "sr"
    "sv"
    "sw"
    "te"
    "tr"
    "uk"
    "vi"
    "zh"
)

# Default options (passed to trigger-benchmark.sh)
WATCH="true"
NUM_RUNS="1"
WHISPER_MODEL="medium"
USE_GPU="true"
BRANCH=""
REMOTE="upstream"
CSV_OUTPUT="benchmarks/results/benchmark-history.csv"
SHEET_URL=""
SHEET_ID=""
SHEET_NAME="Benchmark Results"
NO_CSV="false"
DRY_RUN="false"
PARALLEL="false"
SKIP_LANGUAGES=""
ONLY_LANGUAGES=""

show_help() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Trigger benchmark workflow for all supported languages.

OPTIONS:
    -n, --num-runs          Number of runs per sample (default: $NUM_RUNS)
    -w, --whisper-model     Whisper model: tiny, base, small, medium (default: $WHISPER_MODEL)
    -g, --use-gpu           Enable GPU acceleration: true/false (default: $USE_GPU)
    -b, --branch            Git branch to run workflow on (default: current branch)
    -R, --remote            Git remote to use: origin, upstream (default: $REMOTE)
    -o, --output            CSV output file path (default: $CSV_OUTPUT)
    --sheet-id              Google Sheet ID for direct API access (requires gcloud auth)
    --sheet-name            Sheet/tab name in Google Sheets (default: $SHEET_NAME)
    -S, --sheet-url         Google Sheets Apps Script URL (deprecated)
    --no-csv                Skip CSV output (use with --sheet-id)
    --no-watch              Don't watch workflows (just trigger them)
    --dry-run               Print commands without executing
    --skip                  Comma-separated languages to skip (e.g., "ar,zh,hi")
    --only                  Only run these languages (comma-separated, e.g., "en-us,es,de")
    -h, --help              Show this help message

SUPPORTED LANGUAGES (${#LANGUAGES[@]} total):
    ${LANGUAGES[*]}

EXAMPLES:
    # Run for all languages
    $(basename "$0")

    # Skip certain languages
    $(basename "$0") --skip "ar,zh,hi"

    # Run only specific languages
    $(basename "$0") --only "en-us,es,de,fr"

    # Dry run to see what would be executed
    $(basename "$0") --dry-run

    # Run without watching (just trigger all)
    $(basename "$0") --no-watch

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--num-runs)
            NUM_RUNS="$2"
            shift 2
            ;;
        -w|--whisper-model)
            WHISPER_MODEL="$2"
            shift 2
            ;;
        -g|--use-gpu)
            USE_GPU="$2"
            shift 2
            ;;
        -b|--branch)
            BRANCH="$2"
            shift 2
            ;;
        -R|--remote)
            REMOTE="$2"
            shift 2
            ;;
        -o|--output)
            CSV_OUTPUT="$2"
            shift 2
            ;;
        --sheet-id)
            SHEET_ID="$2"
            shift 2
            ;;
        --sheet-name)
            SHEET_NAME="$2"
            shift 2
            ;;
        -S|--sheet-url)
            SHEET_URL="$2"
            shift 2
            ;;
        --no-csv)
            NO_CSV="true"
            shift
            ;;
        --no-watch)
            WATCH="false"
            shift
            ;;
        --dry-run)
            DRY_RUN="true"
            shift
            ;;
        --skip)
            SKIP_LANGUAGES="$2"
            shift 2
            ;;
        --only)
            ONLY_LANGUAGES="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}"
            show_help
            exit 1
            ;;
    esac
done

# Convert skip languages to array
IFS=',' read -ra SKIP_ARRAY <<< "$SKIP_LANGUAGES"

# Convert only languages to array (if specified)
if [ -n "$ONLY_LANGUAGES" ]; then
    IFS=',' read -ra LANGUAGES <<< "$ONLY_LANGUAGES"
fi

# Function to check if language should be skipped
should_skip() {
    local lang="$1"
    for skip in "${SKIP_ARRAY[@]}"; do
        if [ "$lang" = "$skip" ]; then
            return 0
        fi
    done
    return 1
}

# Build base command arguments
BASE_ARGS=()
BASE_ARGS+=("-n" "$NUM_RUNS")
BASE_ARGS+=("-w" "$WHISPER_MODEL")
BASE_ARGS+=("-g" "$USE_GPU")
BASE_ARGS+=("-R" "$REMOTE")

if [ "$NO_CSV" != "true" ]; then
    BASE_ARGS+=("-o" "$CSV_OUTPUT")
else
    BASE_ARGS+=("--no-csv")
fi

if [ -n "$SHEET_ID" ]; then
    BASE_ARGS+=("--sheet-id" "$SHEET_ID")
    BASE_ARGS+=("--sheet-name" "$SHEET_NAME")
elif [ -n "$SHEET_URL" ]; then
    BASE_ARGS+=("-S" "$SHEET_URL")
fi

if [ -n "$BRANCH" ]; then
    BASE_ARGS+=("-b" "$BRANCH")
fi

if [ "$WATCH" = "true" ]; then
    BASE_ARGS+=("-W")
fi

# Count languages to run
TOTAL=0
for lang in "${LANGUAGES[@]}"; do
    if ! should_skip "$lang"; then
        ((TOTAL++))
    fi
done

echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}  Benchmark All Languages${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Remote:           $REMOTE"
echo "  Branch:           ${BRANCH:-current}"
echo "  Num Runs:         $NUM_RUNS"
echo "  Whisper Model:    $WHISPER_MODEL"
echo "  Use GPU:          $USE_GPU"
echo "  Watch:            $WATCH"
if [ "$NO_CSV" != "true" ]; then
    echo "  CSV Output:       $CSV_OUTPUT"
fi
if [ -n "$SHEET_ID" ]; then
    echo "  Google Sheet ID:  $SHEET_ID"
    echo "  Sheet Name:       $SHEET_NAME"
elif [ -n "$SHEET_URL" ]; then
    echo "  Google Sheets:    Yes (Apps Script)"
fi
echo "  Languages:        $TOTAL"
echo "  Dry Run:          $DRY_RUN"
if [ -n "$SKIP_LANGUAGES" ]; then
    echo "  Skipping:         $SKIP_LANGUAGES"
fi
echo ""

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN - Commands that would be executed:${NC}"
    echo ""
fi

# Track progress
CURRENT=0
SUCCESSFUL=0
FAILED=0
FAILED_LANGS=()

# Run benchmark for each language
for lang in "${LANGUAGES[@]}"; do
    # Skip if in skip list
    if should_skip "$lang"; then
        echo -e "${YELLOW}Skipping $lang${NC}"
        continue
    fi
    
    ((CURRENT++))
    
    echo -e "${CYAN}[$CURRENT/$TOTAL] Running benchmark for: $lang${NC}"
    echo "----------------------------------------"
    
    # Build command
    CMD="$SCRIPT_DIR/trigger-benchmark.sh"
    CMD_ARGS=("${BASE_ARGS[@]}" "-l" "$lang")
    
    if [ "$DRY_RUN" = "true" ]; then
        echo "  $CMD ${CMD_ARGS[*]}"
        echo ""
    else
        if "$CMD" "${CMD_ARGS[@]}"; then
            ((SUCCESSFUL++))
            echo -e "${GREEN}Completed: $lang${NC}"
        else
            ((FAILED++))
            FAILED_LANGS+=("$lang")
            echo -e "${RED}Failed: $lang${NC}"
        fi
        echo ""
    fi
done

# Summary
echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}  Summary${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}Dry run complete. $TOTAL languages would be processed.${NC}"
else
    echo -e "Total:      $TOTAL"
    echo -e "${GREEN}Successful: $SUCCESSFUL${NC}"
    echo -e "${RED}Failed:     $FAILED${NC}"
    
    if [ ${#FAILED_LANGS[@]} -gt 0 ]; then
        echo ""
        echo -e "${RED}Failed languages:${NC}"
        for lang in "${FAILED_LANGS[@]}"; do
            echo "  - $lang"
        done
    fi
    
    echo ""
    echo -e "Results saved to: ${GREEN}$CSV_OUTPUT${NC}"
fi
