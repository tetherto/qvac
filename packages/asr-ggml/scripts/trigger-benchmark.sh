#!/bin/bash

# Trigger the ASR GGML accuracy benchmark GitHub Action workflow from local
# Usage: ./scripts/trigger-benchmark.sh [options]

set -e

ENGINE="parakeet"
MODEL_TYPE="tdt"
MAX_SAMPLES="50"
BRANCH=""
REMOTE="upstream"
WATCH="false"
WORKFLOW="benchmark-asr-ggml.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

show_help() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Trigger the ASR GGML accuracy benchmark GitHub Action workflow.

OPTIONS:
    -e, --engine            Engine: whisper, parakeet (default: $ENGINE)
    -t, --model-type        Parakeet model type: tdt, ctc, eou, sortformer, all (default: $MODEL_TYPE)
    -m, --max-samples       Maximum samples to test, 0 = unlimited (default: $MAX_SAMPLES)
    -b, --branch            Git branch to run workflow on (default: current branch)
    -R, --remote            Git remote to use: origin, upstream (default: $REMOTE)
    -W, --watch             Watch workflow run until completion
    -h, --help              Show this help message

EXAMPLES:
    # Run TDT benchmark (default)
    $(basename "$0")

    # Run CTC benchmark
    $(basename "$0") -t ctc

    # Run EOU benchmark with 100 samples
    $(basename "$0") -t eou -m 100

    # Run sortformer benchmark and watch
    $(basename "$0") -t sortformer -W

    # Run all model types
    $(basename "$0") -t all

    # Run on a specific branch
    $(basename "$0") -t ctc -b main

EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--engine)
            ENGINE="$2"
            shift 2
            ;;
        -t|--model-type)
            MODEL_TYPE="$2"
            shift 2
            ;;
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

# Validate engine
case "$ENGINE" in
    whisper|parakeet) ;;
    *)
        echo -e "${RED}Error: Invalid engine '$ENGINE'. Must be one of: whisper, parakeet${NC}"
        exit 1
        ;;
esac

# Validate model type (parakeet-only input)
case "$MODEL_TYPE" in
    tdt|ctc|eou|sortformer|all) ;;
    *)
        echo -e "${RED}Error: Invalid model type '$MODEL_TYPE'. Must be one of: tdt, ctc, eou, sortformer, all${NC}"
        exit 1
        ;;
esac

if ! command -v gh &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is not installed.${NC}"
    echo "Please install it from: https://cli.github.com/"
    exit 1
fi

if ! gh auth status &> /dev/null; then
    echo -e "${RED}Error: Not authenticated with GitHub CLI.${NC}"
    echo "Please run: gh auth login"
    exit 1
fi

if [ -z "$BRANCH" ]; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
fi

REMOTE_URL=$(git remote get-url "$REMOTE" 2>/dev/null)
if [ -z "$REMOTE_URL" ]; then
    echo -e "${RED}Error: Remote '$REMOTE' not found.${NC}"
    echo "Available remotes:"
    git remote -v
    exit 1
fi

if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
else
    echo -e "${RED}Error: Could not parse repository from remote URL: $REMOTE_URL${NC}"
    exit 1
fi

echo -e "${GREEN}Triggering ASR GGML benchmark workflow...${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Remote:       $REMOTE"
echo "  Repository:   $REPO"
echo "  Branch:       $BRANCH"
echo "  Engine:       $ENGINE"
echo "  Model Type:   $MODEL_TYPE"
echo "  Max Samples:  $MAX_SAMPLES"
echo "  Watch:        $WATCH"
echo ""

WORKFLOW_ARGS=(-f engine="$ENGINE" -f max_samples="$MAX_SAMPLES")
if [ "$ENGINE" = "parakeet" ]; then
    WORKFLOW_ARGS+=(-f model_type="$MODEL_TYPE")
fi

if ! gh workflow run "$WORKFLOW" \
    -R "$REPO" \
    --ref "$BRANCH" \
    "${WORKFLOW_ARGS[@]}"; then
    echo -e "${RED}Failed to trigger workflow.${NC}"
    exit 1
fi

echo -e "${GREEN}Workflow triggered successfully!${NC}"
echo ""

sleep 3

RUN_ID=$(gh run list --workflow="$WORKFLOW" -R "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    echo -e "${RED}Error: Could not get workflow run ID.${NC}"
    exit 1
fi

echo "Workflow Run ID: $RUN_ID"
echo "View at: https://github.com/$REPO/actions/runs/$RUN_ID"
echo ""

if [ "$WATCH" = "true" ]; then
    echo -e "${YELLOW}Watching workflow run...${NC}"
    echo ""
    gh run watch "$RUN_ID" -R "$REPO"

    RUN_STATUS=$(gh run view "$RUN_ID" -R "$REPO" --json conclusion --jq '.conclusion')

    if [ "$RUN_STATUS" != "success" ]; then
        echo -e "${RED}Workflow failed with status: $RUN_STATUS${NC}"
        echo "Check the logs at: https://github.com/$REPO/actions/runs/$RUN_ID"
        exit 1
    fi

    echo ""
    echo -e "${GREEN}Workflow completed successfully!${NC}"
else
    echo "To watch the run:"
    echo "  gh run watch $RUN_ID -R $REPO"
fi
