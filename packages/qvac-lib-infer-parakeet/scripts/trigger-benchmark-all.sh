#!/bin/bash

# Trigger Parakeet Benchmark for all model types (tdt, ctc, eou, sortformer)
# Usage: ./scripts/trigger-benchmark-all.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

MODEL_TYPES=("tdt" "ctc" "eou" "sortformer")
MAX_SAMPLES="50"
BRANCH=""
REMOTE="upstream"
WATCH="false"
DRY_RUN="false"
SKIP_TYPES=""
ONLY_TYPES=""
USE_ALL_FLAG="false"

show_help() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Trigger Parakeet Benchmark workflow for all supported model types.

By default, triggers a separate workflow run for each model type.
Use --single-run to trigger a single workflow with all models in one matrix.

OPTIONS:
    -m, --max-samples       Max samples per test, 0 = unlimited (default: $MAX_SAMPLES)
    -b, --branch            Git branch to run workflow on (default: current branch)
    -R, --remote            Git remote to use: origin, upstream (default: $REMOTE)
    -W, --watch             Watch each workflow run until completion
    --single-run            Trigger one workflow run with model_type=all (combined matrix)
    --skip                  Comma-separated model types to skip (e.g., "sortformer,eou")
    --only                  Only run these model types (comma-separated, e.g., "ctc,eou")
    --dry-run               Print commands without executing
    -h, --help              Show this help message

MODEL TYPES:
    tdt         Token-and-Duration Transducer (multilingual, accurate)
    ctc         Connectionist Temporal Classification (English, faster)
    eou         End-of-Utterance (streaming, low latency)
    sortformer  Speaker diarization (no WER/CER)

EXAMPLES:
    # Run all model types (separate workflow per type)
    $(basename "\$0")

    # Run all model types in a single workflow run
    $(basename "\$0") --single-run

    # Run only CTC and EOU
    $(basename "\$0") --only "ctc,eou"

    # Skip sortformer
    $(basename "\$0") --skip "sortformer"

    # Dry run to see what would be executed
    $(basename "\$0") --dry-run

    # Run with custom sample count and watch
    $(basename "\$0") -m 100 -W

EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--max-samples)
            MAX_SAMPLES="$2"
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
        -W|--watch)
            WATCH="true"
            shift
            ;;
        --single-run)
            USE_ALL_FLAG="true"
            shift
            ;;
        --skip)
            SKIP_TYPES="$2"
            shift 2
            ;;
        --only)
            ONLY_TYPES="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN="true"
            shift
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

IFS=',' read -ra SKIP_ARRAY <<< "$SKIP_TYPES"

if [ -n "$ONLY_TYPES" ]; then
    IFS=',' read -ra MODEL_TYPES <<< "$ONLY_TYPES"
fi

should_skip() {
    local mtype="$1"
    for skip in "${SKIP_ARRAY[@]}"; do
        if [ "$mtype" = "$skip" ]; then
            return 0
        fi
    done
    return 1
}

TOTAL=0
for mtype in "${MODEL_TYPES[@]}"; do
    if ! should_skip "$mtype"; then
        ((TOTAL++))
    fi
done

echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}  Parakeet Benchmark - All Model Types${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Remote:       $REMOTE"
echo "  Branch:       ${BRANCH:-current}"
echo "  Max Samples:  $MAX_SAMPLES"
echo "  Watch:        $WATCH"
echo "  Single Run:   $USE_ALL_FLAG"
echo "  Model Types:  $TOTAL"
echo "  Dry Run:      $DRY_RUN"
if [ -n "$SKIP_TYPES" ]; then
    echo "  Skipping:     $SKIP_TYPES"
fi
echo ""

# Single workflow run mode
if [ "$USE_ALL_FLAG" = "true" ]; then
    echo -e "${CYAN}Triggering single workflow with model_type=all...${NC}"
    echo ""

    CMD_ARGS=("-t" "all" "-m" "$MAX_SAMPLES" "-R" "$REMOTE")
    if [ -n "$BRANCH" ]; then
        CMD_ARGS+=("-b" "$BRANCH")
    fi
    if [ "$WATCH" = "true" ]; then
        CMD_ARGS+=("-W")
    fi

    if [ "$DRY_RUN" = "true" ]; then
        echo "  $SCRIPT_DIR/trigger-benchmark.sh ${CMD_ARGS[*]}"
    else
        "$SCRIPT_DIR/trigger-benchmark.sh" "${CMD_ARGS[@]}"
    fi
    exit $?
fi

# Per-model-type mode
if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN - Commands that would be executed:${NC}"
    echo ""
fi

CURRENT=0
SUCCESSFUL=0
FAILED=0
FAILED_TYPES=()

for mtype in "${MODEL_TYPES[@]}"; do
    if should_skip "$mtype"; then
        echo -e "${YELLOW}Skipping $mtype${NC}"
        continue
    fi

    ((CURRENT++))

    echo -e "${CYAN}[$CURRENT/$TOTAL] Running benchmark for: $mtype${NC}"
    echo "----------------------------------------"

    CMD_ARGS=("-t" "$mtype" "-m" "$MAX_SAMPLES" "-R" "$REMOTE")
    if [ -n "$BRANCH" ]; then
        CMD_ARGS+=("-b" "$BRANCH")
    fi
    if [ "$WATCH" = "true" ]; then
        CMD_ARGS+=("-W")
    fi

    if [ "$DRY_RUN" = "true" ]; then
        echo "  $SCRIPT_DIR/trigger-benchmark.sh ${CMD_ARGS[*]}"
        echo ""
    else
        if "$SCRIPT_DIR/trigger-benchmark.sh" "${CMD_ARGS[@]}"; then
            ((SUCCESSFUL++))
            echo -e "${GREEN}Completed: $mtype${NC}"
        else
            ((FAILED++))
            FAILED_TYPES+=("$mtype")
            echo -e "${RED}Failed: $mtype${NC}"
        fi
        echo ""
    fi
done

echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN}  Summary${NC}"
echo -e "${CYAN}==========================================${NC}"
echo ""

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}Dry run complete. $TOTAL model types would be processed.${NC}"
else
    echo -e "Total:      $TOTAL"
    echo -e "${GREEN}Successful: $SUCCESSFUL${NC}"
    echo -e "${RED}Failed:     $FAILED${NC}"

    if [ ${#FAILED_TYPES[@]} -gt 0 ]; then
        echo ""
        echo -e "${RED}Failed model types:${NC}"
        for mtype in "${FAILED_TYPES[@]}"; do
            echo "  - $mtype"
        done
    fi
fi
