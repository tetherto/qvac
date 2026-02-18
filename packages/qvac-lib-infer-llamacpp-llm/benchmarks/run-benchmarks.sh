#!/bin/bash

# LlamaCpp Benchmark Runner Script
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

# Parse command line arguments - only set if explicitly provided
SAMPLES=""
DATASETS=""
DEVICE=$DEFAULT_DEVICE
MODELS=""
SKIP_EXISTING=false
PORT=""
COMPARE=false
TRANSFORMERS_MODEL=""
GGUF_MODEL=""
HF_TOKEN=""
TEMPERATURE=""
CTX_SIZE=""
GPU_LAYERS=""
TOP_P=""
N_PREDICT=""
TOP_K=""
REPEAT_PENALTY=""
SEED=""
ADDON_VERSION=""

print_help() {
    cat << EOF
LlamaCpp Benchmark Runner

Benchmarks the @qvac/llm-llamacpp addon using either:
  - Locally built addon (default) - uses file:../../ to link the local workspace
  - Published npm package - use --addon-version to install a specific version

Usage: ./benchmarks/run-benchmarks.sh [options]

Options:
  --samples <number>     Number of samples per dataset (default: 10)
  --datasets <list>      Comma-separated list of datasets or "all" (default: all)
                         Available: gsm8k, mmlu, squad, arc
  --device <type>        Device type: cpu, gpu (default: $DEFAULT_DEVICE)
  --skip-existing        Skip models that already have results for today
  --port <number>        Server port (default: 7357, useful for parallel runs)
  --addon-version <ver>  Install specific @qvac/llm-llamacpp version from npm
                         Examples: "0.6.0", "^0.5.0", "latest"
                         Default: uses locally built addon (file:../../)
  --compare              Run comparative evaluation (@qvac/llm-llamacpp addon vs transformers)
                         Compares native C++ addon implementation vs Python transformers
  --gguf-model <spec>    GGUF model for addon (required with --compare)
                         Formats:
                           HuggingFace: "owner/repo" or "owner/repo:quantization"
                           Hyperdrive: "hd://key" or "hd://key/model.gguf"
                         Examples: "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"
                                   "hd://{KEY}/model.gguf"
  --transformers-model <name>  HuggingFace transformers model for comparison (required with --compare)
  --hf-token <token>     HuggingFace token (optional, needed for gated models)
                         Get token at: https://huggingface.co/settings/tokens
                         Required permission: Read (read-only access)
  --temperature <float>  Temperature for text generation (e.g., 0.1, 0.7, 1.0)
  --ctx-size <int>       Context window size (e.g., 1024, 4096, 8192)
  --gpu-layers <str>     Number of GPU layers (e.g., '0', '50', '99', '999')
  --top-p <float>        Top-p sampling parameter (e.g., 0.8, 0.9, 0.95)
  --n-predict <int>      Maximum number of tokens to predict (e.g., 500, 1000, 2000)
  --top-k <int>          Top-k sampling parameter (e.g., 40, 50, 80)
  --repeat-penalty <float>  Repeat penalty (e.g., 1.0, 1.1, 1.2)
  --seed <int>           Random seed for reproducibility (e.g., 42, 123, -1)
  --verbose              Enable verbose output
  --help                 Show this help message

Examples:
  # Test with locally built addon (default - for development)
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --samples 10
  
  # Test with published npm package (for CI/release verification)
  ./benchmarks/run-benchmarks.sh --addon-version "0.6.0" --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --samples 10
  
  # Test specific datasets  
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --datasets "gsm8k,mmlu" --samples 5
  
  # P2P hyperdrive model
  ./benchmarks/run-benchmarks.sh --gguf-model "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf" --samples 10

Comparative Evaluation Examples (@qvac addon vs transformers):
  
  # Compare addon (HuggingFace GGUF) vs transformers (same model architecture)
  ./benchmarks/run-benchmarks.sh --compare --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --transformers-model "meta-llama/Llama-3.2-1B-Instruct" --hf-token YOUR_TOKEN --samples 10 --temperature 0.1 --top-p 0.8 --top-k 30 --repeat-penalty 1.1 --seed 1
  ./benchmarks/run-benchmarks.sh --compare --gguf-model "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_0" --transformers-model "meta-llama/Llama-3.2-3B-Instruct" --hf-token YOUR_TOKEN
  
  # Compare addon (Hyperdrive GGUF) vs transformers
  ./benchmarks/run-benchmarks.sh --compare --gguf-model "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf" --transformers-model "meta-llama/Llama-3.2-1B-Instruct" --hf-token YOUR_TOKEN
  
  # With custom parameters to test performance characteristics
  ./benchmarks/run-benchmarks.sh --compare --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --transformers-model "meta-llama/Llama-3.2-1B-Instruct" --hf-token YOUR_TOKEN --samples 50 --datasets "gsm8k,squad"

Parameter Tuning Examples:
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --temperature 0.1 --top-p 0.8 --n-predict 200 # Conservative/deterministic
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --temperature 0.9 --top-p 0.95 --n-predict 1000 # Creative/diverse
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --ctx-size 1024 --gpu-layers 25 --n-predict 100 # Performance-optimized
  ./benchmarks/run-benchmarks.sh --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --gpu-layers 0 --ctx-size 512 # CPU-only evaluation
  ./benchmarks/run-benchmarks.sh --gguf-model "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf" --temperature 0.2 --ctx-size 2048 # P2P with custom params

Addon Version Examples:
  ./benchmarks/run-benchmarks.sh --addon-version "0.3.2" --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --samples 10 # Test specific addon version
  ./benchmarks/run-benchmarks.sh --addon-version "^0.3.0" --compare --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" --transformers-model "meta-llama/Llama-3.2-1B-Instruct" --hf-token YOUR_TOKEN # Compare with version range

EOF
}

log() {
    local message="$1"
    local verbose_only="${2:-false}"
    
    if [[ "$verbose_only" == "false" ]] || [[ "$VERBOSE" == "true" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $message"
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
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
        --skip-existing)
            SKIP_EXISTING=true
            shift
            ;;
        --compare)
            COMPARE=true
            shift
            ;;
        --transformers-model)
            TRANSFORMERS_MODEL="$2"
            shift 2
            ;;
        --gguf-model)
            GGUF_MODEL="$2"
            shift 2
            ;;
        --hf-token)
            HF_TOKEN="$2"
            shift 2
            ;;
        --temperature)
            TEMPERATURE="$2"
            shift 2
            ;;
        --ctx-size)
            CTX_SIZE="$2"
            shift 2
            ;;
        --gpu-layers)
            GPU_LAYERS="$2"
            shift 2
            ;;
        --top-p)
            TOP_P="$2"
            shift 2
            ;;
        --n-predict)
            N_PREDICT="$2"
            shift 2
            ;;
        --top-k)
            TOP_K="$2"
            shift 2
            ;;
        --repeat-penalty)
            REPEAT_PENALTY="$2"
            shift 2
            ;;
        --seed)
            SEED="$2"
            shift 2
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --addon-version)
            ADDON_VERSION="$2"
            shift 2
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

check_prerequisites() {
    log "🔍 Checking prerequisites..."
    
    # Check if we're in the right directory
    if [[ ! -d "benchmarks" ]]; then
        echo "❌ Error: benchmarks directory not found. Please run from project root."
        exit 1
    fi
    
    # Check if server directory exists
    if [[ ! -d "benchmarks/server" ]]; then
        echo "❌ Error: benchmarks/server directory not found."
        exit 1
    fi
    
    # Check if client directory exists
    if [[ ! -d "benchmarks/client" ]]; then
        echo "❌ Error: benchmarks/client directory not found."
        exit 1
    fi
    
    # Check if bare is available
    if ! command -v bare &> /dev/null; then
        echo "❌ Error: 'bare' runtime not found. Please install bare runtime."
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
        echo "❌ Error: Python 'venv' module not found. Please install it:"
        echo "   Ubuntu/Debian: sudo apt-get install python3-venv"
        echo "   macOS: Should be included with Python 3"
        echo "   Others: pip3 install virtualenv"
        exit 1
    fi
    
    log "✅ Prerequisites check passed"
}

setup_environment() {
    log "🔧 Setting up environment..."
    
    # Install server dependencies
    log "Installing server dependencies..."
    cd benchmarks/server
    npm install
    
    # Install specific addon version if requested
    if [[ -n "$ADDON_VERSION" ]]; then
        log "📦 Installing specific addon version: @qvac/llm-llamacpp@$ADDON_VERSION"
        log "   This will override the local development version (file:../../)"
        
        if npm install "@qvac/llm-llamacpp@$ADDON_VERSION" 2>&1; then
            log "✅ Successfully installed @qvac/llm-llamacpp@$ADDON_VERSION"
        else
            echo "❌ Error: Failed to install @qvac/llm-llamacpp@$ADDON_VERSION"
            echo "   Make sure the version exists on npm registry"
            echo "   Try: npm view @qvac/llm-llamacpp versions"
            cd ../..
            exit 1
        fi
    else
        log "Using local development version of @qvac/llm-llamacpp (file:../../)"
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
        log "Running: python3 -m venv venv" true
        
        if ! python3 -m venv venv 2>&1; then
            echo "❌ Error: Failed to create Python virtual environment"
            echo "   Python version: $(python3 --version)"
            echo "   Try manually running: cd benchmarks/client && python3 -m venv venv"
            cd ../..
            exit 1
        fi
        
        # Verify venv was created successfully
        if [[ ! -f "venv/bin/activate" ]]; then
            echo "❌ Error: Virtual environment creation failed - activate script not found"
            echo "   Python version: $(python3 --version)"
            echo "   Python location: $(which python3)"
            echo "   Venv directory contents:"
            ls -la venv/ 2>/dev/null || echo "   venv directory is empty or doesn't exist"
            cd ../..
            exit 1
        fi
        
        log "✅ Virtual environment created successfully"
    else
        log "Using existing virtual environment"
    fi
    
    # Install Python dependencies
    log "Installing Python dependencies..."
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    cd ../..
    
    
    log "✅ Environment setup completed"
}

# Function to check required models
get_server_port() {
    echo "${PORT:-7357}"
}

start_server() {
    log "🚀 Starting benchmark server..."
    
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
    
    # Start server in background with custom port
    # Use env to pass PORT variable to npm without affecting parent shell
    env PORT=$TARGET_PORT npm run start > server.log 2>&1 &
    SERVER_PID=$!
    cd ../..
    
    # Wait for server to start
    log "Waiting for server to start on port $TARGET_PORT..."
    sleep 1  # Give server a moment to initialize
    
    for i in {1..30}; do
        SERVER_PORT=$(get_server_port)
        if curl -f http://localhost:$SERVER_PORT/ >/dev/null 2>&1; then
            log "✅ Server started successfully (PID: $SERVER_PID, Port: $SERVER_PORT)"
            return 0
        fi
        
        # Check if server process is still running
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            log "❌ Server process died, checking logs..."
        if [[ -f "benchmarks/server/server.log" ]]; then
                    tail -10 benchmarks/server/server.log
                fi
            return 1
        fi
        
        log "Attempt $i: Server not ready yet, waiting..." true
        sleep 2
    done
    
    echo "❌ Error: Server failed to start within 60 seconds"
    return 1
}


run_benchmarks() {
    log "📊 Running benchmarks..."
    
    cd benchmarks/client
    
    # Build Python command with arguments
    PYTHON_CMD="python evaluate_llama.py"
    
    # Add GGUF model if provided
    if [[ -n "$GGUF_MODEL" ]]; then
        PYTHON_CMD="$PYTHON_CMD --gguf-model \"$GGUF_MODEL\""
    fi
    
    # Add CLI parameter overrides using the centralized function
    PYTHON_CMD=$(add_parameter_overrides "$PYTHON_CMD")
        
    # Log configuration
    log "Configuration:"
    if [[ -n "$GGUF_MODEL" ]]; then
        log "  Model: $GGUF_MODEL"
    else
        log "  Model: not specified"
    fi
    if [[ -n "$SAMPLES" ]]; then
        log "  Samples: $SAMPLES (CLI override)"
    else
        log "  Samples: 10 (default)"
    fi
    if [[ -n "$DATASETS" ]]; then
        log "  Datasets: $DATASETS (CLI override)"
    else
        log "  Datasets: $AVAILABLE_DATASETS (default)"
    fi
    log "  Device: $DEVICE"
    
    if [[ "$VERBOSE" == "true" ]]; then
        log "Python command: $PYTHON_CMD" true
    fi
    
    # Run the benchmark
    source venv/bin/activate
    
    log "🔍 Testing server connection first..."
    
    # Get the server port
    SERVER_PORT=$(get_server_port)
    
    # Test if server can handle requests
    if curl -f http://localhost:$SERVER_PORT/ >/dev/null 2>&1; then
        log "✅ Server is responding on port $SERVER_PORT, running addon benchmark..."
        
        if [[ "$VERBOSE" == "true" ]]; then
            if eval $PYTHON_CMD; then
                log "✅ Addon benchmark completed successfully"
            else
                log "❌ Addon benchmark failed"
                return 1
            fi
        else
            if eval $PYTHON_CMD 2>&1 | grep -E "(Starting|Completed|Error|Results|Accuracy|F1|EM|MMLU|GSM8K|ARC|SQuAD|📈)"; then
                log "✅ Addon benchmark completed successfully"
            else
                log "❌ Addon benchmark failed"
                return 1
            fi
        fi
    else
        log "❌ Server not responding on port $SERVER_PORT"
        return 1
    fi
    
    cd ../..
    log "✅ Benchmarks completed"
}

cleanup() {
    log "🧹 Cleaning up..."
    
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
    
    log "✅ Cleanup completed"
}

# Function to add CLI parameter overrides to Python command
add_parameter_overrides() {
    local cmd="$1"
    
    # Add CLI overrides if provided
    if [[ -n "$SAMPLES" ]]; then
        cmd="$cmd --samples $SAMPLES"
    fi
    
    if [[ -n "$DATASETS" ]]; then
        cmd="$cmd --datasets \"$DATASETS\""
    fi
    
    if [[ "$DEVICE" != "$DEFAULT_DEVICE" ]]; then
        cmd="$cmd --device $DEVICE"
    fi
    
    # Add server port if custom port is specified
    if [[ -n "$PORT" ]]; then
        cmd="$cmd --port $PORT"
    fi
    
    # Add model parameter overrides
    if [[ -n "$TEMPERATURE" ]]; then
        cmd="$cmd --temperature $TEMPERATURE"
    fi
    
    if [[ -n "$CTX_SIZE" ]]; then
        cmd="$cmd --ctx-size $CTX_SIZE"
    fi
    
    if [[ -n "$GPU_LAYERS" ]]; then
        cmd="$cmd --gpu-layers $GPU_LAYERS"
    fi
    
    if [[ -n "$TOP_P" ]]; then
        cmd="$cmd --top-p $TOP_P"
    fi
    
    if [[ -n "$N_PREDICT" ]]; then
        cmd="$cmd --n-predict $N_PREDICT"
    fi
    
    if [[ -n "$TOP_K" ]]; then
        cmd="$cmd --top-k $TOP_K"
    fi
    
    if [[ -n "$REPEAT_PENALTY" ]]; then
        cmd="$cmd --repeat-penalty $REPEAT_PENALTY"
    fi
    
    if [[ -n "$SEED" ]]; then
        cmd="$cmd --seed $SEED"
    fi
    
    echo "$cmd"
}

# Set up signal handlers for cleanup
trap cleanup EXIT INT TERM

# Available benchmark datasets
AVAILABLE_DATASETS="gsm8k,mmlu,squad,arc"

get_available_datasets() {
    echo "$AVAILABLE_DATASETS"
}

# Function to check if model has results for today
has_results_today() {
    local model_id="$1"
    local today=$(date '+%Y-%m-%d')
    # Transform model_id to match directory structure
    local dir_name="${model_id##*/}"
    dir_name="${dir_name//:/_}"
    local results_file="benchmarks/results/$dir_name/$today.md"
    
    [[ -f "$results_file" ]]
}

# Function to run benchmark for a single model
run_single_model_benchmark() {
    local model_id="$1"
    local start_time=$(date +%s)
    
    log "🚀 Starting benchmark for model: $model_id"
    
    # Check if we should skip existing results
    if [[ "$SKIP_EXISTING" == "true" ]] && has_results_today "$model_id"; then
        log "⏭️  Skipping $model_id (results already exist for today)"
        return 0
    fi
    
    # Build Python command with model-specific arguments
        PYTHON_CMD="python evaluate_llama.py --gguf-model \"$model_id\""
        
        # Add CLI parameter overrides
        PYTHON_CMD=$(add_parameter_overrides "$PYTHON_CMD")
    
    # Run the benchmark in the client directory
    cd benchmarks/client
    
    log "Running: $PYTHON_CMD" true
    
    # Run the benchmark
    source venv/bin/activate
    
    if [[ "$VERBOSE" == "true" ]]; then
        if eval $PYTHON_CMD; then
            local end_time=$(date +%s)
            local duration=$((end_time - start_time))
            log "✅ Completed benchmark for $model_id (${duration}s)"
            deactivate
            cd ../..
            return 0
        else
            log "❌ Failed benchmark for $model_id"
            deactivate
            cd ../..
            return 1
        fi
    else
        if eval $PYTHON_CMD 2>&1 | grep -E "(Starting|Completed|Error|Results|Accuracy|F1|EM|MMLU|GSM8K|ARC|SQuAD|📈)"; then
            local end_time=$(date +%s)
            local duration=$((end_time - start_time))
            log "✅ Completed benchmark for $model_id (${duration}s)"
            deactivate
            cd ../..
            return 0
        else
            log "❌ Failed benchmark for $model_id"
            deactivate
            cd ../..
            return 1
        fi
    fi
}

main() {
        log "🚀 Starting LlamaCpp Benchmark Runner"
        
        # Handle comparative mode
        if [[ "$COMPARE" == "true" ]]; then
        if [[ -z "$GGUF_MODEL" ]]; then
            echo "❌ Error: --gguf-model is required when using --compare"
            echo "Examples:"
            echo "  --gguf-model \"bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0\" (HuggingFace repo)"
            echo "  --gguf-model \"hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf\" (Hyperdrive P2P)"
            exit 1
        fi
        
        if [[ -z "$TRANSFORMERS_MODEL" ]]; then
            echo "❌ Error: --transformers-model is required when using --compare"
            exit 1
        fi
        
        if [[ -z "$HF_TOKEN" ]]; then
            log "⚠️  No HuggingFace token provided. Will use public models only."
            HF_TOKEN=""
        fi
        
        log "🔄 Running comparative evaluation mode"
        log "Comparing @qvac/llm-llamacpp addon vs HuggingFace transformers"
        log "Addon GGUF model: $GGUF_MODEL"
        log "Transformers model: $TRANSFORMERS_MODEL"
        
        check_prerequisites
        setup_environment
        
        if start_server; then
            cd benchmarks/client
            source venv/bin/activate
            
                # Build comparative Python command
            PYTHON_CMD="python evaluate_llama.py --compare-implementations --gguf-model \"$GGUF_MODEL\" --transformers-model \"$TRANSFORMERS_MODEL\""
            
            # Add HF token if provided
            if [[ -n "$HF_TOKEN" ]]; then
                PYTHON_CMD="$PYTHON_CMD --hf-token \"$HF_TOKEN\""
            fi
                
                # Add CLI parameter overrides
                PYTHON_CMD=$(add_parameter_overrides "$PYTHON_CMD")
            
            log "Running comparative evaluation: $PYTHON_CMD"
            
            if [[ "$VERBOSE" == "true" ]]; then
                eval $PYTHON_CMD
            else
                eval $PYTHON_CMD 2>&1 | grep -E "(Starting|Completed|Error|Results|Accuracy|F1|EM|MMLU|GSM8K|ARC|SQuAD|📊|📈|✅|❌)"
            fi
            
            deactivate
            cd ../..
            log "✅ Comparative evaluation completed!"
        else
            echo "❌ Failed to start server for comparative evaluation"
            exit 1
        fi
        return
    fi
    
    # Process datasets argument
    if [[ -n "$DATASETS" ]]; then
        if [[ "$DATASETS" == "all" ]]; then
            # Get all available datasets
            DATASETS=$(get_available_datasets)
            log "📊 Using all available datasets: $DATASETS"
        else
            log "📊 Using specified datasets: $DATASETS"
        fi
    fi
    
    # Single model mode
    log "Configuration: samples=$SAMPLES, datasets=$DATASETS, device=$DEVICE, model=$GGUF_MODEL"
    
    check_prerequisites
    setup_environment
    
    if start_server; then
        run_benchmarks
        log "🎉 Benchmark run completed successfully!"
    else
        echo "❌ Failed to start server"
        exit 1
    fi
}

# Run main function
main
