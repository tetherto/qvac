#!/bin/bash

# Script to trigger the Benchmark GitHub Action workflow from local
# Usage: ./scripts/trigger-benchmark.sh [options]

set -e

# Default values
ADDON_VERSION="latest"
DATASET="harvard"
MAX_SAMPLES="0"
RUN_ADDON="true"
RUN_PYTHON="true"
ROUND_TRIP_TEST="true"
WHISPER_MODEL="medium"
NUM_RUNS="1"
USE_GPU="true"
LANGUAGE="en-us"
BRANCH="fix/benchmarks"
REMOTE="upstream"
WATCH="false"
CSV_OUTPUT="benchmarks/results/benchmark-history.csv"
SHEET_URL=""
SHEET_ID="1V9-MVHWatby7zrwx7uiZHmV5zXzkocN_H9LiFGO6gZw"
SHEET_NAME="benchmark-history"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

show_help() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Trigger the Benchmark GitHub Action workflow.

OPTIONS:
    -v, --addon-version     Version of @qvac/tts-onnx to benchmark (default: $ADDON_VERSION)
    -d, --dataset           Dataset for benchmarking: harvard, ag_news, librispeech (default: $DATASET)
    -m, --max-samples       Maximum samples to test, 0 = unlimited (default: $MAX_SAMPLES)
    -a, --run-addon         Run TTS Addon benchmark: true/false (default: $RUN_ADDON)
    -p, --run-python        Run Python Native benchmark: true/false (default: $RUN_PYTHON)
    -r, --round-trip        Enable round-trip quality test: true/false (default: $ROUND_TRIP_TEST)
    -w, --whisper-model     Whisper model: tiny, base, small, medium (default: $WHISPER_MODEL)
    -n, --num-runs          Number of runs per sample (default: $NUM_RUNS)
    -g, --use-gpu           Enable GPU acceleration: true/false (default: $USE_GPU)
    -l, --language          Language code, e.g., en-us, es, de (default: $LANGUAGE)
    -b, --branch            Git branch to run workflow on (default: current branch)
    -R, --remote            Git remote to use: origin, upstream (default: $REMOTE)
    -W, --watch             Watch workflow and parse results to CSV/Sheets (default: $WATCH)
    -o, --output            CSV output file path (default: $CSV_OUTPUT)
    -S, --sheet-url         Google Sheets Apps Script URL for results (deprecated)
    --sheet-id              Google Sheet ID for direct API access (requires gcloud auth)
    --sheet-name            Sheet/tab name in Google Sheets (default: $SHEET_NAME)
    --no-csv                Skip CSV output (use with --sheet-id)
    -h, --help              Show this help message

EXAMPLES:
    # Run with defaults (uses upstream remote)
    $(basename "$0")

    # Run with specific version and dataset
    $(basename "$0") -v 0.1.0 -d librispeech

    # Run addon only with 5 samples
    $(basename "$0") -a true -p false -m 5

    # Run on a specific branch
    $(basename "$0") -b main

    # Run on origin remote instead of upstream
    $(basename "$0") -R origin

    # Watch workflow and save results to CSV
    $(basename "$0") -W

    # Watch and save to custom CSV file
    $(basename "$0") -W -o results.csv

    # Watch and save results to Google Sheets (requires: gcloud auth login)
    $(basename "$0") -W --sheet-id "YOUR_SHEET_ID"

    # Save to Google Sheets only (no CSV)
    $(basename "$0") -W --sheet-id "YOUR_SHEET_ID" --no-csv

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -v|--addon-version)
            ADDON_VERSION="$2"
            shift 2
            ;;
        -d|--dataset)
            DATASET="$2"
            shift 2
            ;;
        -m|--max-samples)
            MAX_SAMPLES="$2"
            shift 2
            ;;
        -a|--run-addon)
            RUN_ADDON="$2"
            shift 2
            ;;
        -p|--run-python)
            RUN_PYTHON="$2"
            shift 2
            ;;
        -r|--round-trip)
            ROUND_TRIP_TEST="$2"
            shift 2
            ;;
        -w|--whisper-model)
            WHISPER_MODEL="$2"
            shift 2
            ;;
        -n|--num-runs)
            NUM_RUNS="$2"
            shift 2
            ;;
        -g|--use-gpu)
            USE_GPU="$2"
            shift 2
            ;;
        -l|--language)
            LANGUAGE="$2"
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
        -o|--output)
            CSV_OUTPUT="$2"
            shift 2
            ;;
        -S|--sheet-url)
            SHEET_URL="$2"
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
        --no-csv)
            CSV_OUTPUT=""
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

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is not installed.${NC}"
    echo "Please install it from: https://cli.github.com/"
    exit 1
fi

# Check if authenticated with gh
if ! gh auth status &> /dev/null; then
    echo -e "${RED}Error: Not authenticated with GitHub CLI.${NC}"
    echo "Please run: gh auth login"
    exit 1
fi

# Get current branch if not specified
if [ -z "$BRANCH" ]; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
fi

# Get repository from the specified remote
REMOTE_URL=$(git remote get-url "$REMOTE" 2>/dev/null)
if [ -z "$REMOTE_URL" ]; then
    echo -e "${RED}Error: Remote '$REMOTE' not found.${NC}"
    echo "Available remotes:"
    git remote -v
    exit 1
fi

# Extract OWNER/REPO from remote URL (handles both HTTPS and SSH formats)
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
else
    echo -e "${RED}Error: Could not parse repository from remote URL: $REMOTE_URL${NC}"
    exit 1
fi

echo -e "${GREEN}Triggering Benchmark workflow...${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Remote:           $REMOTE"
echo "  Repository:       $REPO"
echo "  Branch:           $BRANCH"
echo "  Addon Version:    $ADDON_VERSION"
echo "  Dataset:          $DATASET"
echo "  Max Samples:      $MAX_SAMPLES"
echo "  Run Addon:        $RUN_ADDON"
echo "  Run Python:       $RUN_PYTHON"
echo "  Round-Trip Test:  $ROUND_TRIP_TEST"
echo "  Whisper Model:    $WHISPER_MODEL"
echo "  Num Runs:         $NUM_RUNS"
echo "  Use GPU:          $USE_GPU"
echo "  Language:         $LANGUAGE"
echo "  Watch & Parse:    $WATCH"
if [ "$WATCH" = "true" ]; then
    if [ -n "$CSV_OUTPUT" ]; then
        echo "  CSV Output:       $CSV_OUTPUT"
    fi
    if [ -n "$SHEET_ID" ]; then
        echo "  Google Sheet ID:  $SHEET_ID"
        echo "  Sheet Name:       $SHEET_NAME"
    elif [ -n "$SHEET_URL" ]; then
        echo "  Google Sheets:    Yes (Apps Script)"
    fi
fi
echo ""

# Trigger the workflow
gh workflow run benchmark.yaml \
    -R "$REPO" \
    --ref "$BRANCH" \
    -f addon_version="$ADDON_VERSION" \
    -f dataset="$DATASET" \
    -f max_samples="$MAX_SAMPLES" \
    -f run_addon="$RUN_ADDON" \
    -f run_python="$RUN_PYTHON" \
    -f round_trip_test="$ROUND_TRIP_TEST" \
    -f whisper_model="$WHISPER_MODEL" \
    -f num_runs="$NUM_RUNS" \
    -f use_gpu="$USE_GPU" \
    -f language="$LANGUAGE"

if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to trigger workflow.${NC}"
    exit 1
fi

echo -e "${GREEN}Workflow triggered successfully!${NC}"
echo ""

# Wait a moment for the workflow to register
sleep 3

# Get the latest run ID for the benchmark workflow
RUN_ID=$(gh run list --workflow=benchmark.yaml -R "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')

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
    
    # Watch the workflow until completion
    gh run watch "$RUN_ID" -R "$REPO"
    
    # Get the run status
    RUN_STATUS=$(gh run view "$RUN_ID" -R "$REPO" --json conclusion --jq '.conclusion')
    
    if [ "$RUN_STATUS" != "success" ]; then
        echo -e "${RED}Workflow failed with status: $RUN_STATUS${NC}"
        echo "Check the logs at: https://github.com/$REPO/actions/runs/$RUN_ID"
        exit 1
    fi
    
    echo ""
    echo -e "${GREEN}Workflow completed successfully!${NC}"
    echo ""
    echo -e "${YELLOW}Downloading benchmark results...${NC}"
    
    # Create temp directory for artifacts
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT
    
    # Download the benchmark results artifact
    ARTIFACT_NAME="benchmark-results-v${ADDON_VERSION}"
    gh run download "$RUN_ID" -R "$REPO" -n "$ARTIFACT_NAME" -D "$TEMP_DIR" 2>/dev/null || {
        # Try with just "benchmark-results" pattern if version-specific fails
        gh run download "$RUN_ID" -R "$REPO" -p "benchmark-results-*" -D "$TEMP_DIR" 2>/dev/null || {
            echo -e "${RED}Error: Could not download benchmark artifacts.${NC}"
            exit 1
        }
    }
    
    echo -e "${GREEN}Artifacts downloaded.${NC}"
    echo ""
    
    # Find the addon results file
    ADDON_RESULTS_FILE=$(find "$TEMP_DIR" -name "*_addon.md" -type f | head -1)
    
    if [ -z "$ADDON_RESULTS_FILE" ] || [ ! -f "$ADDON_RESULTS_FILE" ]; then
        echo -e "${RED}Error: Could not find addon results file.${NC}"
        echo "Contents of temp directory:"
        find "$TEMP_DIR" -type f
        exit 1
    fi
    
    # Find the Python results file (optional)
    PYTHON_RESULTS_FILE=$(find "$TEMP_DIR" -name "*_python-native.md" -type f | head -1)
    
    echo -e "${YELLOW}Parsing benchmark results...${NC}"
    echo ""
    
    # Parse metrics from the addon results file (macOS compatible using grep + awk)
    ADDON_CONTENT=$(cat "$ADDON_RESULTS_FILE")
    
    # Extract Addon Average RTF (e.g., **Average RTF:** 6.7758)
    ADDON_RTF=$(echo "$ADDON_CONTENT" | grep -E '\*\*Average RTF:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
    [ -z "$ADDON_RTF" ] && ADDON_RTF="N/A"
    
    # Extract Average WER (e.g., - **Average WER:** 3.57%)
    AVG_WER=$(echo "$ADDON_CONTENT" | grep -E '\*\*Average WER:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
    [ -z "$AVG_WER" ] && AVG_WER="N/A"
    
    # Extract Average CER (e.g., - **Average CER:** 1.00%)
    AVG_CER=$(echo "$ADDON_CONTENT" | grep -E '\*\*Average CER:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
    [ -z "$AVG_CER" ] && AVG_CER="N/A"
    
    # Extract Model name from header or Model field
    MODEL_NAME=$(echo "$ADDON_CONTENT" | grep -E '^\*\*Model:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
    [ -z "$MODEL_NAME" ] && MODEL_NAME="chatterbox-tts"
    
    # Parse Python metrics if results file exists
    PYTHON_RTF="N/A"
    PYTHON_WER="N/A"
    PYTHON_CER="N/A"
    if [ -n "$PYTHON_RESULTS_FILE" ] && [ -f "$PYTHON_RESULTS_FILE" ]; then
        PYTHON_CONTENT=$(cat "$PYTHON_RESULTS_FILE")
        
        # Extract Python RTF
        PYTHON_RTF=$(echo "$PYTHON_CONTENT" | grep -E '\*\*Average RTF:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
        [ -z "$PYTHON_RTF" ] && PYTHON_RTF="N/A"
        
        # Extract Python WER
        PYTHON_WER=$(echo "$PYTHON_CONTENT" | grep -E '\*\*Average WER:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
        [ -z "$PYTHON_WER" ] && PYTHON_WER="N/A"
        
        # Extract Python CER
        PYTHON_CER=$(echo "$PYTHON_CONTENT" | grep -E '\*\*Average CER:\*\*' | awk -F':**' '{print $2}' | tr -d ' ' | head -1)
        [ -z "$PYTHON_CER" ] && PYTHON_CER="N/A"
    fi
    
    # Get current date
    DATE=$(date '+%Y-%m-%d %H:%M:%S')
    
    echo -e "${GREEN}Parsed Results:${NC}"
    echo "  Date:           $DATE"
    echo "  Language:       $LANGUAGE"
    echo "  Model:          $MODEL_NAME"
    echo ""
    echo "  ${YELLOW}Addon:${NC}"
    echo "    RTF:          $ADDON_RTF"
    echo "    WER:          $AVG_WER"
    echo "    CER:          $AVG_CER"
    echo ""
    echo "  ${YELLOW}Python:${NC}"
    echo "    RTF:          $PYTHON_RTF"
    echo "    WER:          $PYTHON_WER"
    echo "    CER:          $PYTHON_CER"
    echo ""
    echo "  Run ID:         $RUN_ID"
    echo "  Branch:         $BRANCH"
    echo ""
    
    # Save to CSV if output path is set
    if [ -n "$CSV_OUTPUT" ]; then
        # Ensure output directory exists
        CSV_DIR=$(dirname "$CSV_OUTPUT")
        mkdir -p "$CSV_DIR"
        
        # Create CSV header if file doesn't exist
        if [ ! -f "$CSV_OUTPUT" ]; then
            echo "Date,Language,Model,Addon_RTF,Addon_WER,Addon_CER,Python_RTF,Python_WER,Python_CER,Run_ID,Branch,Dataset,Addon_Version" > "$CSV_OUTPUT"
            echo -e "${GREEN}Created new CSV file: $CSV_OUTPUT${NC}"
        fi
        
        # Append results to CSV
        echo "\"$DATE\",\"$LANGUAGE\",\"$MODEL_NAME\",\"$ADDON_RTF\",\"$AVG_WER\",\"$AVG_CER\",\"$PYTHON_RTF\",\"$PYTHON_WER\",\"$PYTHON_CER\",\"$RUN_ID\",\"$BRANCH\",\"$DATASET\",\"$ADDON_VERSION\"" >> "$CSV_OUTPUT"
        
        echo -e "${GREEN}Results appended to: $CSV_OUTPUT${NC}"
    fi
    
    # Save to Google Sheets using direct API (preferred method)
    if [ -n "$SHEET_ID" ]; then
        echo -e "${YELLOW}Sending results to Google Sheets...${NC}"
        
        # Check if gcloud is installed
        if ! command -v gcloud &> /dev/null; then
            echo -e "${RED}Error: gcloud CLI is not installed.${NC}"
            echo "Install with: brew install google-cloud-sdk"
            echo "Then run: gcloud auth login"
        else
            # Get OAuth token
            ACCESS_TOKEN=$(gcloud auth print-access-token 2>/dev/null)
            
            if [ -z "$ACCESS_TOKEN" ]; then
                echo -e "${RED}Error: Not authenticated with gcloud.${NC}"
                echo "Please run: gcloud auth login"
            else
                # Build the row data as JSON array
                ROW_DATA=$(cat <<EOF
{
    "values": [
        ["$DATE", "$LANGUAGE", "$MODEL_NAME", "$ADDON_RTF", "$AVG_WER", "$AVG_CER", "$PYTHON_RTF", "$PYTHON_WER", "$PYTHON_CER", "$RUN_ID", "$BRANCH", "$DATASET", "$ADDON_VERSION"]
    ]
}
EOF
)
                # URL encode the sheet name
                ENCODED_SHEET_NAME=$(echo "$SHEET_NAME" | sed 's/ /%20/g')
                
                # Append to Google Sheets using Sheets API
                SHEETS_API_URL="https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${ENCODED_SHEET_NAME}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"
                
                SHEET_RESPONSE=$(curl -s -X POST \
                    -H "Authorization: Bearer $ACCESS_TOKEN" \
                    -H "Content-Type: application/json" \
                    -d "$ROW_DATA" \
                    "$SHEETS_API_URL" 2>&1)
                
                # Check response
                if echo "$SHEET_RESPONSE" | grep -q '"updatedRows"'; then
                    echo -e "${GREEN}Results added to Google Sheets successfully!${NC}"
                elif echo "$SHEET_RESPONSE" | grep -q '"error"'; then
                    echo -e "${RED}Warning: Failed to add to Google Sheets${NC}"
                    echo "Full response: $SHEET_RESPONSE"
                    
                    # Check if sheet doesn't exist and create header
                    if echo "$SHEET_RESPONSE" | grep -q "Unable to parse range"; then
                        echo -e "${YELLOW}Sheet '$SHEET_NAME' may not exist. Creating with headers...${NC}"
                        
                        # Create header row
                        HEADER_DATA='{"values": [["Date", "Language", "Model", "Addon_RTF", "Addon_WER", "Addon_CER", "Python_RTF", "Python_WER", "Python_CER", "Run_ID", "Branch", "Dataset", "Addon_Version"]]}'
                        
                        curl -s -X PUT \
                            -H "Authorization: Bearer $ACCESS_TOKEN" \
                            -H "Content-Type: application/json" \
                            -d "$HEADER_DATA" \
                            "https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${ENCODED_SHEET_NAME}!A1?valueInputOption=USER_ENTERED" > /dev/null
                        
                        # Retry append
                        SHEET_RESPONSE=$(curl -s -X POST \
                            -H "Authorization: Bearer $ACCESS_TOKEN" \
                            -H "Content-Type: application/json" \
                            -d "$ROW_DATA" \
                            "$SHEETS_API_URL" 2>&1)
                        
                        if echo "$SHEET_RESPONSE" | grep -q '"updatedRows"'; then
                            echo -e "${GREEN}Results added to Google Sheets successfully!${NC}"
                        fi
                    fi
                else
                    echo -e "${GREEN}Results added to Google Sheets!${NC}"
                fi
            fi
        fi
    # Fallback to Apps Script URL if provided (deprecated)
    elif [ -n "$SHEET_URL" ]; then
        echo -e "${YELLOW}Sending results to Google Sheets (Apps Script)...${NC}"
        
        # Build JSON payload
        JSON_PAYLOAD=$(cat <<EOF
{
    "date": "$DATE",
    "language": "$LANGUAGE",
    "model": "$MODEL_NAME",
    "addon_rtf": "$ADDON_RTF",
    "addon_wer": "$AVG_WER",
    "addon_cer": "$AVG_CER",
    "python_rtf": "$PYTHON_RTF",
    "python_wer": "$PYTHON_WER",
    "python_cer": "$PYTHON_CER",
    "run_id": "$RUN_ID",
    "branch": "$BRANCH",
    "dataset": "$DATASET",
    "addon_version": "$ADDON_VERSION"
}
EOF
)
        
        # POST to Google Sheets Apps Script (follow redirects)
        SHEET_RESPONSE=$(curl -s -L -X POST \
            -H "Content-Type: application/json" \
            -H "Accept: application/json" \
            -d "$JSON_PAYLOAD" \
            "$SHEET_URL" 2>&1)
        
        # Check response
        if echo "$SHEET_RESPONSE" | grep -q '"status":"success"'; then
            echo -e "${GREEN}Results added to Google Sheets successfully!${NC}"
        else
            echo -e "${RED}Warning: Failed to add to Google Sheets${NC}"
            echo "Response: $SHEET_RESPONSE"
        fi
    fi
    echo ""
    
    # Display the full addon results file
    echo -e "${YELLOW}Full Addon Benchmark Results:${NC}"
    echo "----------------------------------------"
    cat "$ADDON_RESULTS_FILE"
    echo "----------------------------------------"
    
    # Display Python results if available
    if [ -n "$PYTHON_RESULTS_FILE" ] && [ -f "$PYTHON_RESULTS_FILE" ]; then
        echo ""
        echo -e "${YELLOW}Full Python Benchmark Results:${NC}"
        echo "----------------------------------------"
        cat "$PYTHON_RESULTS_FILE"
        echo "----------------------------------------"
    fi
else
    echo "View the workflow run at:"
    echo "  gh run list --workflow=benchmark.yaml -R $REPO"
    echo ""
    echo "Or watch the latest run:"
    echo "  gh run watch $RUN_ID -R $REPO"
    echo ""
    echo "To watch and parse results, run with -W flag:"
    echo "  $(basename "$0") -W"
fi
