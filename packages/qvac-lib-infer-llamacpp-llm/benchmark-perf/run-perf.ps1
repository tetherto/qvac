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

try {
  python -c "import psutil" | Out-Null
} catch {
  Write-Host "==> Installing Python deps"
  Push-Location "$PerfDir"
  pip install -r benchmark-perf/requirements.txt
  Pop-Location
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
& python "$PerfDir/benchmark-perf/pytorch-perf.py" --config $Config --params $Params --reps $Reps @hfArgs

if ($Judge) {
  Write-Host "==> Running judge"
  Get-ChildItem "$PerfDir/benchmark-perf/results" -Filter "qvac_*.jsonl" | ForEach-Object {
    & bare "$PerfDir/benchmark-perf/judge.js" --config $Config --input $_.FullName
  }
}

if ($Analyze) {
  Write-Host "==> Running analysis"
  & python "$PerfDir/benchmark-perf/analysis/analyze.py" --input "$PerfDir/benchmark-perf/results" --output "$PerfDir/benchmark-perf/analysis/plots"
}
