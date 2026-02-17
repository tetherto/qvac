# LlamaCpp Benchmark Runner Script for Windows PowerShell
# Usage: .\benchmarks\run-benchmarks.ps1 [options]

param(
    [int]$samples,
    [string]$datasets,
    [string]$device = "gpu",
    [switch]$skipExisting,
    [int]$port,
    [string]$addonVersion,
    [switch]$compare,
    [string]$transformersModel,
    [string]$ggufModel,
    [string]$hfToken,
    [double]$temperature,
    [int]$ctxSize,
    [string]$gpuLayers,
    [double]$topP,
    [int]$topK,
    [int]$nPredict,
    [double]$repeatPenalty,
    [int]$seed,
    [switch]$verbose,
    [switch]$help
)

$ErrorActionPreference = "Stop"

function Show-Help {
    Write-Host @"
LlamaCpp Benchmark Runner (PowerShell)

Usage: .\benchmarks\run-benchmarks.ps1 [options]

Options:
  -samples <number>            Number of samples per dataset
  -datasets <list>             Comma-separated list of datasets or "all"
                              Available: gsm8k, mmlu, squad, arc
  -device <type>               Device type: cpu, gpu (default: gpu)
  -models <list>               Comma-separated list of HuggingFace GGUF model specs
                              Format: "owner/repo:quantization"
  -skipExisting                Skip models that already have results for today
  -port <number>               Server port (default: 7357)
  -addonVersion <version>      Install specific @qvac/llm-llamacpp version (e.g., "0.3.2")
                              Default: uses local development version
  -compare                     Run comparative evaluation (addon vs transformers)
  -ggufModel <spec>            GGUF model for addon (required with -compare)
                              Formats: HuggingFace ("owner/repo:quantization")
                                       Hyperdrive ("hd://key/model.gguf")
  -transformersModel <name>    HuggingFace transformers model (required with -compare)
  -hfToken <token>             HuggingFace token for gated models
  -temperature <float>         Temperature for text generation (e.g., 0.1, 0.7, 1.0)
  -ctxSize <int>               Context window size (e.g., 1024, 4096, 8192)
  -gpuLayers <string>          Number of GPU layers (e.g., '0', '50', '99')
  -topP <float>                Top-p sampling parameter (e.g., 0.8, 0.9, 0.95)
  -topK <int>                  Top-k sampling parameter (e.g., 40, 50, 80)
  -nPredict <int>              Maximum tokens to predict (e.g., 500, 1000, 2000)
  -repeatPenalty <float>       Repeat penalty (e.g., 1.0, 1.1, 1.2)
  -seed <int>                  Random seed for reproducibility (e.g., 42, 123, -1)
  -verbose                     Enable verbose output
  -help                        Show this help message

Examples:
  # Test single model
  .\benchmarks\run-benchmarks.ps1 -ggufModel "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" -samples 10
  
  # Test with custom parameters
  .\benchmarks\run-benchmarks.ps1 -ggufModel "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" -samples 50 -temperature 0.8 -topP 0.95 -topK 50 -seed 42
  
  # Test multiple models
  .\benchmarks\run-benchmarks.ps1 -models "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0,bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_0" -samples 50
  
  # Comparative analysis
  .\benchmarks\run-benchmarks.ps1 -compare -ggufModel "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" -transformersModel "meta-llama/Llama-3.2-1B-Instruct" -hfToken $env:HF_TOKEN -samples 10
  
  # Hyperdrive P2P model
  .\benchmarks\run-benchmarks.ps1 -ggufModel "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf" -samples 10
  
  # Advanced parameter tuning
  .\benchmarks\run-benchmarks.ps1 -ggufModel "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" -samples 100 -temperature 0.6 -topK 40 -repeatPenalty 1.1 -presencePenalty 0.1 -seed 123

"@
    exit 0
}

if ($help) {
    Show-Help
}

Write-Host "=== LlamaCpp Benchmark Runner (PowerShell) ===" -ForegroundColor Cyan

# Get server port
$serverPort = if ($port) { $port } else { 7357 }
Write-Host "Using port: $serverPort" -ForegroundColor Green

# Get the directory where this script is located (benchmarks/)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Navigate to project root (parent of benchmarks directory)
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

# Install server dependencies
Write-Host "`nInstalling server dependencies..." -ForegroundColor Yellow
Set-Location "benchmarks/server"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install server dependencies"
    exit 1
}

# Install specific addon version if requested
if ($addonVersion) {
    Write-Host "`nInstalling specific addon version: @qvac/llm-llamacpp@$addonVersion" -ForegroundColor Yellow
    Write-Host "   This will override the local development version" -ForegroundColor Gray
    
    npm install "@qvac/llm-llamacpp@$addonVersion"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install @qvac/llm-llamacpp@$addonVersion"
        Write-Host "Make sure the version exists on npm registry" -ForegroundColor Red
        Write-Host "Try: npm view @qvac/llm-llamacpp versions" -ForegroundColor Yellow
        Set-Location $projectRoot
        exit 1
    }
    Write-Host "Successfully installed @qvac/llm-llamacpp@$addonVersion" -ForegroundColor Green
} else {
    Write-Host "Using local development version of @qvac/llm-llamacpp" -ForegroundColor Gray
}

Set-Location $projectRoot

# Setup Python virtual environment
Write-Host "`nSetting up Python virtual environment..." -ForegroundColor Yellow
Set-Location "benchmarks/client"

# Check Python version is 3.10+
$pythonVersion = python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
if (-not $pythonVersion) {
    Write-Error "Python not found! Please install Python 3.10+."
    exit 1
}
$versionParts = $pythonVersion.Split('.')
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]
if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
    Write-Error "Python 3.10+ required, but found Python $pythonVersion. Please upgrade."
    exit 1
}
Write-Host "Python version: $pythonVersion" -ForegroundColor Green

# Check if venv module is available
python -m venv --help > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error @"
Python venv module not found!
Please ensure Python 3.10+ is installed with venv support.
Install from: https://www.python.org/downloads/
"@
    exit 1
}

# Create venv if it doesn't exist
if (-not (Test-Path "venv")) {
    Write-Host "Creating Python virtual environment..." -ForegroundColor Yellow
    python -m venv venv
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create Python virtual environment"
        exit 1
    }
}

# Verify venv was created successfully
if (-not (Test-Path "venv/Scripts/Activate.ps1")) {
    Write-Error @"
Virtual environment creation failed!
venv/Scripts/Activate.ps1 not found.

Python version: $(python --version)
Python location: $(Get-Command python).Source

Attempting to remove incomplete venv and retry...
"@
    Remove-Item -Recurse -Force venv -ErrorAction SilentlyContinue
    python -m venv venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "venv/Scripts/Activate.ps1")) {
        Write-Error "Failed to create virtual environment after retry"
        exit 1
    }
}

# Activate venv and install dependencies
Write-Host "Activating virtual environment and installing dependencies..." -ForegroundColor Yellow
& "venv/Scripts/Activate.ps1"
pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install Python dependencies"
    deactivate
    exit 1
}

Set-Location $projectRoot

# Start server in background
Write-Host "`nStarting benchmark server on port $serverPort..." -ForegroundColor Yellow
$env:PORT = $serverPort
$serverProcess = Start-Process -FilePath "bare" -ArgumentList "benchmarks/server/index.js" -PassThru -NoNewWindow

# Wait for server to be ready
Write-Host "Waiting for server to be ready..." -ForegroundColor Yellow
$maxWait = 60
$waited = 0
$serverReady = $false

while ($waited -lt $maxWait) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$serverPort/" -TimeoutSec 1 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $serverReady = $true
            break
        }
    } catch {
        # Server not ready yet
    }
    Start-Sleep -Seconds 2
    $waited += 2
    Write-Host "." -NoNewline
}

Write-Host ""

if (-not $serverReady) {
    Write-Error "Server failed to start within $maxWait seconds"
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Server started successfully!" -ForegroundColor Green

# Build Python command
Write-Host "`nRunning benchmarks..." -ForegroundColor Yellow
Set-Location "benchmarks/client"

$pythonArgs = @("evaluate_llama.py")

if ($samples) { $pythonArgs += "--samples", $samples }
if ($datasets) { $pythonArgs += "--datasets", $datasets }
if ($device) { $pythonArgs += "--device", $device }
if ($skipExisting) { $pythonArgs += "--skip-existing" }
if ($port) { $pythonArgs += "--port", $port }
if ($compare) { $pythonArgs += "--compare" }
if ($transformersModel) { $pythonArgs += "--transformers-model", $transformersModel }
if ($ggufModel) { $pythonArgs += "--gguf-model", $ggufModel }
if ($hfToken) { $pythonArgs += "--hf-token", $hfToken }
if ($temperature) { $pythonArgs += "--temperature", $temperature }
if ($ctxSize) { $pythonArgs += "--ctx-size", $ctxSize }
if ($gpuLayers) { $pythonArgs += "--gpu-layers", $gpuLayers }
if ($topP) { $pythonArgs += "--top-p", $topP }
if ($topK) { $pythonArgs += "--top-k", $topK }
if ($nPredict) { $pythonArgs += "--n-predict", $nPredict }
if ($repeatPenalty) { $pythonArgs += "--repeat-penalty", $repeatPenalty }
if ($seed) { $pythonArgs += "--seed", $seed }
if ($verbose) { $pythonArgs += "--verbose" }

# Run Python client
& "venv/Scripts/python.exe" @pythonArgs
$pythonExitCode = $LASTEXITCODE

# Cleanup
Write-Host "`nCleaning up..." -ForegroundColor Yellow
Set-Location $projectRoot

# Stop server
Write-Host "Stopping server..." -ForegroundColor Yellow
Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue

# Kill any remaining bare processes
Get-Process -Name "bare" -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "`n=== Benchmark Complete ===" -ForegroundColor Cyan

# Show GPU status if available (Windows with NVIDIA)
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    Write-Host "`nGPU Status:" -ForegroundColor Yellow
    nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv
}

exit $pythonExitCode

