#!/bin/bash

# EmbedLlamacpp Benchmark Runner Script
# Usage: ./benchmarks/run-benchmarks.sh [options]

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Navigate to project root (parent of benchmarks directory)
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Default configuration
DEFAULT_DEVICE="gpu"
VERBOSE=false

# Parse command line arguments
SAMPLES=""
DATASETS=""
DEVICE=$DEFAULT_DEVICE
PORT=""
COMPARE=false
TRANSFORMERS_MODEL=""
GGUF_MODEL=""
BATCH_SIZE=""
TOKEN_BATCH_SIZE=""
GPU_LAYERS=""
CTX_SIZE=""
VERBOSITY=""
HF_TOKEN=""
ADDON_VERSION=""
SKIP_EXISTING=false

print_help() {
    cat << EOF
EmbedLlamacpp Benchmark Runner

Usage: ./benchmarks/run-benchmarks.sh [options]

Options:
  --gguf-model <spec>        GGUF model specification (required)
                             Formats:
                               - HuggingFace: "owner/repo" or "owner/repo:quantization"
                               - P2P Hyperdrive: "hd://key/model.gguf"
  --hf-token <token>         HuggingFace token for accessing gated models
  --samples <number>         Number of samples per dataset (default: full dataset)
  --datasets <list>          Comma-separated list of datasets or "all"
                             Available: ArguAna, NFCorpus, SciFact, TRECCOVID, SCIDOCS, FiQA2018
  --device <type>            Device type: cpu, gpu (default: gpu)
  --port <number>            Server port (default: 7357)
  --compare                  Run comparative evaluation (addon vs SentenceTransformers)
  --transformers-model <name>  HuggingFace model name (required with --compare)
                             Example: "thenlper/gte-large"
  --batch-size <number>      Tokens for processing multiple prompts together (default: 2048)
  --gpu-layers <string>      Number of GPU layers (default: 99)
  --ctx-size <number>        Context window size (default: 512)
  --verbosity <0-3>          Verbosity level (default: 0)
  --addon-version <ver>      Install specific @qvac/embed-llamacpp version (e.g., "0.9.0", "^0.8.0")
  --skip-existing            Skip if results already exist for today
  --verbose                  Enable verbose output
  --help                     Show this help message

Examples:
  # Single model evaluation (auto-downloads from HuggingFace)
  ./benchmarks/run-benchmarks.sh --gguf-model "ChristianAzinn/gte-large-gguf:F16"
  
  # HuggingFace with token for gated models
  ./benchmarks/run-benchmarks.sh --gguf-model "org/gated-model" --hf-token "\$HF_TOKEN"
  
  # P2P model via Hyperdrive
  ./benchmarks/run-benchmarks.sh --gguf-model "hd://KEY/gte-large_fp16.gguf"
  
  # Specific datasets
  ./benchmarks/run-benchmarks.sh --gguf-model "ChristianAzinn/gte-large-gguf" --datasets "ArguAna,SciFact"
  
  # Comparative analysis (addon vs SentenceTransformers)
  ./benchmarks/run-benchmarks.sh --compare \\
    --gguf-model "ChristianAzinn/gte-large-gguf:F16" \\
    --transformers-model "thenlper/gte-large"
  
  # CPU-only evaluation
  ./benchmarks/run-benchmarks.sh --gguf-model "ChristianAzinn/gte-large-gguf" --device cpu --gpu-layers 0
  
  # Test specific addon version
  ./benchmarks/run-benchmarks.sh --addon-version "0.9.0" --gguf-model "ChristianAzinn/gte-large-gguf:F16"
  
  # Test with version range
  ./benchmarks/run-benchmarks.sh --addon-version "^0.8.0" --gguf-model "ChristianAzinn/gte-large-gguf" --samples 100

EOF
}

log() {
    local message="$1"
    local verbose_only="${2:-false}"
    
    if [[ "$verbose_only" == "false" ]] || [[ "$VERBOSE" == "true" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $message"
    fi
}

# Function to check if model has results for today
has_results_today() {
    local model_spec="$1"
    local today=$(date '+%Y-%m-%d')
    # Transform model spec to directory name (repo/model:quant -> model_quant)
    local dir_name="${model_spec##*/}"
    dir_name="${dir_name//:/_}"
    local results_file="benchmarks/results/$dir_name/$today.md"
    
    [[ -f "$results_file" ]]
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --gguf-model)
            GGUF_MODEL="$2"
            shift 2
            ;;
        --hf-token)
            HF_TOKEN="$2"
            shift 2
            ;;
        --samples)
            SAMPLES="$2"
            shift 2
            ;;
        --datasets)
            DATASETS="$2"
            shift 2
            ;;
        --device)
            DEVICE="$2"
            shift 2
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --compare)
            COMPARE=true
            shift
            ;;
        --transformers-model)
            TRANSFORMERS_MODEL="$2"
            shift 2
            ;;
        --batch-size)
            BATCH_SIZE="$2"
            shift 2
            ;;
        --gpu-layers)
            GPU_LAYERS="$2"
            shift 2
            ;;
        --ctx-size)
            CTX_SIZE="$2"
            shift 2
            ;;
        --verbosity)
            VERBOSITY="$2"
            shift 2
            ;;
        --addon-version)
            ADDON_VERSION="$2"
            shift 2
            ;;
        --skip-existing)
            SKIP_EXISTING=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            print_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            print_help
            exit 1
            ;;
    esac
done

# Validate required arguments
if [[ -z "$GGUF_MODEL" ]]; then
    echo "Error: --gguf-model is required"
    print_help
    exit 1
fi

if [[ "$COMPARE" == "true" ]] && [[ -z "$TRANSFORMERS_MODEL" ]]; then
    echo "Error: --transformers-model is required when using --compare"
    exit 1
fi

check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if we're in the right directory
    if [[ ! -d "benchmarks" ]]; then
        echo "Error: benchmarks directory not found. Please run from project root."
        exit 1
    fi
    
    # Check if server directory exists
    if [[ ! -d "benchmarks/server" ]]; then
        echo "Error: benchmarks/server directory not found."
        exit 1
    fi
    
    # Check if client directory exists
    if [[ ! -d "benchmarks/client" ]]; then
        echo "Error: benchmarks/client directory not found."
        exit 1
    fi
    
    # Check if bare is available
    if ! command -v bare &> /dev/null; then
        echo "Error: 'bare' runtime not found. Please install bare runtime."
        exit 1
    fi
    
    # Check if python3 is available
    if ! command -v python3 &> /dev/null; then
        echo "Error: 'python3' not found. Please install Python 3.10+."
        exit 1
    fi
    
    # Check Python version is 3.10+
    PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
    if [[ "$PYTHON_MAJOR" -lt 3 ]] || [[ "$PYTHON_MAJOR" -eq 3 && "$PYTHON_MINOR" -lt 10 ]]; then
        echo "Error: Python 3.10+ required, but found Python $PYTHON_VERSION"
        echo "Please upgrade Python to version 3.10 or higher."
        exit 1
    fi
    
    # Check if python3 has venv module
    if ! python3 -m venv --help &> /dev/null; then
        echo "Error: Python 'venv' module not found. Please install it:"
        echo "   Ubuntu/Debian: sudo apt-get install python3-venv"
        echo "   macOS: Should be included with Python 3"
        echo "   Others: pip3 install virtualenv"
        exit 1
    fi
    
    log "Prerequisites check passed"
}

setup_environment() {
    log "Setting up environment..."
    
    # Install server dependencies
    log "Installing server dependencies..."
    cd benchmarks/server
    npm install
    
    # Install specific addon version if requested
    if [[ -n "$ADDON_VERSION" ]]; then
        log "Installing specific addon version: @qvac/embed-llamacpp@$ADDON_VERSION"
        log "   This will override the local development version (file:../../)"
        
        if npm install "@qvac/embed-llamacpp@$ADDON_VERSION" 2>&1; then
            log "Successfully installed @qvac/embed-llamacpp@$ADDON_VERSION"
        else
            echo "Error: Failed to install @qvac/embed-llamacpp@$ADDON_VERSION"
            echo "   Make sure the version exists on npm registry"
            echo "   Try: npm view @qvac/embed-llamacpp versions"
            cd ../..
            exit 1
        fi
    else
        log "Using local development version of @qvac/embed-llamacpp (file:../../)"
    fi
    
    cd ../..
    
    # Setup Python virtual environment
    cd benchmarks/client
    
    # Check if venv exists but is broken
    if [[ -d "venv" ]] && [[ ! -f "venv/bin/activate" ]]; then
        log "Removing incomplete virtual environment..."
        rm -rf venv
    fi
    
    if [[ ! -d "venv" ]]; then
        log "Creating Python virtual environment..."
        log "Python version: $(python3 --version)" true
        
        if ! python3 -m venv venv 2>&1; then
            echo "Error: Failed to create Python virtual environment"
            echo "   Python version: $(python3 --version)"
            echo "   Try manually running: cd benchmarks/client && python3 -m venv venv"
            cd ../..
            exit 1
        fi
        
        # Verify venv was created successfully
        if [[ ! -f "venv/bin/activate" ]]; then
            echo "Error: Virtual environment creation failed - activate script not found"
            cd ../..
            exit 1
        fi
        
        log "Virtual environment created successfully"
    else
        log "Using existing virtual environment"
    fi
    
    # Install Python dependencies
    log "Installing Python dependencies..."
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    
    # Install polars with rtcompat extra for CPUs without AVX support (Linux x86_64 only)
    # polars-lts-cpu lacks from_arrow() which mteb requires, so we use polars[rtcompat] instead
    # Mac ARM and modern x86 CPUs work fine with regular polars
    if [[ "$(uname -s)" == "Linux" ]] && [[ "$(uname -m)" == "x86_64" ]]; then
        log "Linux x86_64 detected - installing polars with runtime compatibility support..."
        pip uninstall -y polars polars-runtime-32 polars-lts-cpu 2>/dev/null || true
        pip install "polars[rtcompat]"
    fi
    
    cd ../..
    
    log "Environment setup completed"
}

get_server_port() {
    echo "${PORT:-7357}"
}

start_server() {
    log "Starting benchmark server..."
    
    # Clean up any stale database locks
    if [[ -f "benchmarks/store/db/LOCK" ]]; then
        log "Removing stale database lock file..."
        rm -f benchmarks/store/db/LOCK
    fi
    
    # Kill any existing server processes
    pkill -f "bare index.js" 2>/dev/null || true
    
    # Also kill any process using the target port
    TARGET_PORT=$(get_server_port)
    PORT_PID=$(lsof -ti:$TARGET_PORT 2>/dev/null || true)
    if [[ -n "$PORT_PID" ]]; then
        log "Killing process on port $TARGET_PORT (PID: $PORT_PID)"
        kill -9 $PORT_PID 2>/dev/null || true
    fi
    
    # Wait for port to be free
    for i in {1..5}; do
        if lsof -i:$TARGET_PORT >/dev/null 2>&1; then
            log "Port $TARGET_PORT still in use, waiting..."
            sleep 1
        else
            break
        fi
    done
    
    cd benchmarks/server
    env PORT=$TARGET_PORT npm run start > server.log 2>&1 &
    SERVER_PID=$!
    cd ../..
    
    # Wait for server to start
    log "Waiting for server to start on port $TARGET_PORT..."
    sleep 1
    
    for i in {1..30}; do
        SERVER_PORT=$(get_server_port)
        if curl -f http://localhost:$SERVER_PORT/ >/dev/null 2>&1; then
            log "Server started successfully (PID: $SERVER_PID, Port: $SERVER_PORT)"
            return 0
        fi
        
        # Check if server process is still running
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            log "Server process died, checking logs..."
            if [[ -f "benchmarks/server/server.log" ]]; then
                tail -10 benchmarks/server/server.log
            fi
            return 1
        fi
        
        log "Attempt $i: Server not ready yet, waiting..." true
        sleep 2
    done
    
    echo "Error: Server failed to start within 60 seconds"
    return 1
}

run_benchmarks() {
    log "Running benchmarks..."
    
    # Check if we should skip existing results
    if [[ "$SKIP_EXISTING" == "true" ]] && has_results_today "$GGUF_MODEL"; then
        log "Skipping $GGUF_MODEL (results already exist for today)"
        return 0
    fi
    
    cd benchmarks/client
    source venv/bin/activate
    
    # Build Python command
    PYTHON_CMD="python evaluate_embed.py --gguf-model \"$GGUF_MODEL\""
    
    # Add optional arguments
    if [[ -n "$HF_TOKEN" ]]; then
        PYTHON_CMD="$PYTHON_CMD --hf-token \"$HF_TOKEN\""
    fi
    
    if [[ -n "$SAMPLES" ]]; then
        PYTHON_CMD="$PYTHON_CMD --samples $SAMPLES"
    fi
    
    if [[ -n "$DATASETS" ]]; then
        PYTHON_CMD="$PYTHON_CMD --datasets \"$DATASETS\""
    fi
    
    if [[ "$DEVICE" != "$DEFAULT_DEVICE" ]]; then
        PYTHON_CMD="$PYTHON_CMD --device $DEVICE"
    fi
    
    if [[ -n "$PORT" ]]; then
        PYTHON_CMD="$PYTHON_CMD --port $PORT"
    fi
    
    if [[ "$COMPARE" == "true" ]]; then
        PYTHON_CMD="$PYTHON_CMD --compare --transformers-model \"$TRANSFORMERS_MODEL\""
    fi
    
    if [[ -n "$BATCH_SIZE" ]]; then
        PYTHON_CMD="$PYTHON_CMD --batch-size $BATCH_SIZE"
    fi
    
    if [[ -n "$GPU_LAYERS" ]]; then
        PYTHON_CMD="$PYTHON_CMD --gpu-layers $GPU_LAYERS"
    fi
    
    if [[ -n "$CTX_SIZE" ]]; then
        PYTHON_CMD="$PYTHON_CMD --ctx-size $CTX_SIZE"
    fi
    
    if [[ -n "$VERBOSITY" ]]; then
        PYTHON_CMD="$PYTHON_CMD --verbosity $VERBOSITY"
    fi
    
    log "Running: $PYTHON_CMD" true
    
    # Set POLARS_SKIP_CPU_CHECK to avoid crashes on CPUs without AVX support
    export POLARS_SKIP_CPU_CHECK=1
    
    if eval $PYTHON_CMD; then
        log "Benchmark completed successfully"
    else
        log "Benchmark failed"
        deactivate
        cd ../..
        return 1
    fi
    
    deactivate
    cd ../..
}

cleanup() {
    log "Cleaning up..."
    
    # Stop the server if it's running
    if [[ -n "$SERVER_PID" ]]; then
        log "Stopping server (PID: $SERVER_PID)"
        kill $SERVER_PID 2>/dev/null || true
        sleep 1
    fi
    
    # Kill any remaining bare processes
    pkill -f "bare index.js" 2>/dev/null || true
    
    # Force kill any process on the server port
    SERVER_PORT=$(get_server_port)
    PORT_PID=$(lsof -ti:$SERVER_PORT 2>/dev/null || true)
    if [[ -n "$PORT_PID" ]]; then
        log "Force killing process on port $SERVER_PORT (PID: $PORT_PID)"
        kill -9 $PORT_PID 2>/dev/null || true
    fi
    
    log "Cleanup completed"
}

# Set up signal handlers
trap cleanup EXIT INT TERM

main() {
    log "Starting EmbedLlamacpp Benchmark Runner"
    log "Configuration: gguf-model=$GGUF_MODEL, device=$DEVICE, compare=$COMPARE"
    
    check_prerequisites
    setup_environment
    
    if start_server; then
        run_benchmarks
        log "Benchmark run completed successfully!"
    else
        echo "Failed to start server"
        exit 1
    fi
}

# Run main function
main
