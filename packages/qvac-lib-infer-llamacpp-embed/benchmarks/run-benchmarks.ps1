# EmbedLlamacpp Benchmark Runner Script for Windows PowerShell
# Usage: .\benchmarks\run-benchmarks.ps1 [options]

param(
    [string]$ggufModel,
    [string]$hfToken,
    [int]$samples,
    [string]$datasets,
    [string]$device = "gpu",
    [int]$port,
    [switch]$compare,
    [string]$transformersModel,
    [int]$batchSize,
    [string]$gpuLayers,
    [int]$ctxSize,
    [string]$verbosity,
    [string]$addonVersion,
    [switch]$skipExisting,
    [switch]$verbose,
    [switch]$help
)

$ErrorActionPreference = "Stop"

function Show-Help {
    Write-Host @"
EmbedLlamacpp Benchmark Runner (PowerShell)

Usage: .\benchmarks\run-benchmarks.ps1 [options]

Options:
  -ggufModel <spec>           GGUF model specification (required)
                              Formats:
                                - HuggingFace: "owner/repo" or "owner/repo:quantization"
                                - P2P Hyperdrive: "hd://key/model.gguf"
  -hfToken <token>            HuggingFace token for accessing gated models
  -samples <number>           Number of samples per dataset (default: full dataset)
  -datasets <list>            Comma-separated list of datasets or "all"
                              Available: ArguAna, NFCorpus, SciFact, TRECCOVID, SCIDOCS, FiQA2018
  -device <type>              Device type: cpu, gpu (default: gpu)
  -port <number>              Server port (default: 7357)
  -compare                    Run comparative evaluation (addon vs SentenceTransformers)
  -transformersModel <name>   HuggingFace model name (required with -compare)
                              Example: "thenlper/gte-large"
  -batchSize <number>         Tokens for processing multiple prompts together (default: 2048)
  -gpuLayers <string>         Number of GPU layers (default: 99)
  -ctxSize <number>           Context window size (default: 512)
  -verbosity <0-3>            Verbosity level (default: 0)
  -addonVersion <version>     Install specific @qvac/embed-llamacpp version (e.g., "0.9.0")
  -skipExisting               Skip if results already exist for today
  -verbose                    Enable verbose output
  -help                       Show this help message

Examples:
  # Single model evaluation (auto-downloads from HuggingFace)
  .\benchmarks\run-benchmarks.ps1 -ggufModel "ChristianAzinn/gte-large-gguf:F16"
  
  # HuggingFace with token for gated models
  .\benchmarks\run-benchmarks.ps1 -ggufModel "org/gated-model" -hfToken `$env:HF_TOKEN
  
  # P2P model via Hyperdrive
  .\benchmarks\run-benchmarks.ps1 -ggufModel "hd://KEY/gte-large_fp16.gguf"
  
  # Comparative analysis
  .\benchmarks\run-benchmarks.ps1 -compare -ggufModel "ChristianAzinn/gte-large-gguf:F16" -transformersModel "thenlper/gte-large"
  
  # Test specific addon version
  .\benchmarks\run-benchmarks.ps1 -addonVersion "0.9.0" -ggufModel "ChristianAzinn/gte-large-gguf:F16"
  
  # CPU-only evaluation
  .\benchmarks\run-benchmarks.ps1 -ggufModel "ChristianAzinn/gte-large-gguf" -device cpu -gpuLayers 0

"@
    exit 0
}

if ($help) {
    Show-Help
}

# Validate required arguments
if (-not $ggufModel) {
    Write-Error "Error: -ggufModel is required"
    Show-Help
}

if ($compare -and -not $transformersModel) {
    Write-Error "Error: -transformersModel is required when using -compare"
    exit 1
}

Write-Host "=== EmbedLlamacpp Benchmark Runner (PowerShell) ===" -ForegroundColor Cyan

# Get server port
$serverPort = if ($port) { $port } else { 7357 }
Write-Host "Using port: $serverPort" -ForegroundColor Green

# Get the directory where this script is located (benchmarks/)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Navigate to project root (parent of benchmarks directory)
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

# Install specific addon version if requested
if ($addonVersion) {
    Write-Host "`nInstalling specific addon version: @qvac/embed-llamacpp@$addonVersion" -ForegroundColor Yellow
    Set-Location "benchmarks/server"
    npm install "@qvac/embed-llamacpp@$addonVersion"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install @qvac/embed-llamacpp@$addonVersion"
        exit 1
    }
    Write-Host "Successfully installed @qvac/embed-llamacpp@$addonVersion" -ForegroundColor Green
    Set-Location $projectRoot
}

# Install server dependencies
Write-Host "`nInstalling server dependencies..." -ForegroundColor Yellow
Set-Location "benchmarks/server"
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install server dependencies"
    exit 1
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

# Activate venv and install dependencies
Write-Host "Installing Python dependencies..." -ForegroundColor Yellow
& "venv/Scripts/Activate.ps1"
pip install --upgrade pip
pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install Python dependencies"
    deactivate
    exit 1
}

# Note: polars-lts-cpu is only needed on Linux x86_64 without AVX support
# Windows generally has proper AVX support, so we use regular polars

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

# Check for skip existing
if ($skipExisting) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $dirName = ($ggufModel -split "/")[-1] -replace ":", "_"
    $resultsFile = "benchmarks/results/$dirName/$today.md"
    if (Test-Path $resultsFile) {
        Write-Host "Skipping $ggufModel (results already exist for today)" -ForegroundColor Yellow
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        exit 0
    }
}

# Build Python command
Write-Host "`nRunning benchmarks..." -ForegroundColor Yellow
Set-Location "benchmarks/client"

$pythonArgs = @("evaluate_embed.py", "--gguf-model", $ggufModel)

if ($hfToken) { $pythonArgs += "--hf-token", $hfToken }
if ($samples) { $pythonArgs += "--samples", $samples }
if ($datasets) { $pythonArgs += "--datasets", $datasets }
if ($device) { $pythonArgs += "--device", $device }
if ($port) { $pythonArgs += "--port", $port }
if ($compare) { $pythonArgs += "--compare" }
if ($transformersModel) { $pythonArgs += "--transformers-model", $transformersModel }
if ($batchSize) { $pythonArgs += "--batch-size", $batchSize }
if ($gpuLayers) { $pythonArgs += "--gpu-layers", $gpuLayers }
if ($ctxSize) { $pythonArgs += "--ctx-size", $ctxSize }
if ($verbosity) { $pythonArgs += "--verbosity", $verbosity }

# Set POLARS_SKIP_CPU_CHECK to avoid crashes on CPUs without AVX support
$env:POLARS_SKIP_CPU_CHECK = "1"

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

exit $pythonExitCode
