param(
  [string]$Params = "all",
  [int]$Reps = 3,
  [string]$Config = "$PSScriptRoot/perf-config.json",
  [string]$Addon = "",
  [string]$HfToken = "",
  [switch]$Judge,
  [switch]$Analyze
)

$PerfDir = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$PerfDir/benchmark-perf/node_modules")) {
  Write-Host "==> Installing perf dependencies"
  Push-Location "$PerfDir/benchmark-perf"
  npm install
  Pop-Location
}

if (-not (Test-Path "$PerfDir/node_modules")) {
  Write-Host "==> Installing addon dependencies"
  Push-Location "$PerfDir"
  npm install
  Pop-Location
}

$VenvDir = Join-Path $PerfDir "benchmark-perf/.venv"
if (-not (Test-Path $VenvDir)) {
  Write-Host "==> Creating Python venv"
  python -m venv $VenvDir
}

$VenvPython = Join-Path $VenvDir "Scripts/python.exe"
try {
  & $VenvPython -c "import psutil" | Out-Null
} catch {
  Write-Host "==> Installing Python deps"
  & $VenvPython -m pip install -r (Join-Path $PerfDir "benchmark-perf/requirements.txt")
}
if ($Analyze) {
  try {
    & $VenvPython -c "import pandas, matplotlib, seaborn, sklearn" | Out-Null
  } catch {
    Write-Host "==> Installing analysis deps"
    & $VenvPython -m pip install -r (Join-Path $PerfDir "benchmark-perf/analysis/requirements.txt")
  }
}

Write-Host "==> Running QVAC perf"
$addonArgs = @()
if ($Addon -ne "") {
  $addonArgs += "--addon"
  $addonArgs += $Addon
}
if ($HfToken -ne "") {
  $env:HF_TOKEN = $HfToken
} elseif ($env:HF_TOKEN) {
  $HfToken = $env:HF_TOKEN
}
& bare "$PerfDir/benchmark-perf/qvac-perf.js" --config $Config --params $Params --reps $Reps @addonArgs

Write-Host "==> Running PyTorch perf"
$hfArgs = @()
if ($HfToken -ne "") {
  $hfArgs += "--hf-token"
  $hfArgs += $HfToken
}
& $VenvPython "$PerfDir/benchmark-perf/pytorch-perf.py" --config $Config --params $Params --reps $Reps @hfArgs

if ($Judge) {
  Write-Host "==> Running judge"
  Get-ChildItem "$PerfDir/benchmark-perf/results" -Filter "qvac_*.jsonl" | ForEach-Object {
    & bare "$PerfDir/benchmark-perf/judge.js" --config $Config --input $_.FullName
  }
}

if ($Analyze) {
  Write-Host "==> Running analysis"
  & $VenvPython "$PerfDir/benchmark-perf/analysis/analyze.py" --input "$PerfDir/benchmark-perf/results" --output "$PerfDir/benchmark-perf/analysis/plots"
}
