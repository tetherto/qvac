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

function Is-PathSpec($spec) {
  return [System.IO.Path]::IsPathRooted($spec) -or $spec.StartsWith(".\") -or $spec.StartsWith("..\") -or $spec.StartsWith("~/")
}

function Normalize-AddonModule($spec) {
  if (Is-PathSpec $spec) { return $spec }
  if ($spec -match '^@[^/]+/[^@]+@.+$') { return ($spec -replace '^(@[^/]+/[^@]+)@.+$', '$1') }
  if ($spec -match '^[^@]+@.+$') { return $spec.Substring(0, $spec.LastIndexOf('@')) }
  return $spec
}

function Get-AddonVersion($spec) {
  if ($spec -match '^@[^/]+/[^@]+@(.+)$') { return $matches[1] }
  if ($spec -match '^[^@]+@(.+)$') { return $matches[1] }
  return ""
}

$AddonModule = ""
if ($Addon -ne "") {
  $AddonModule = Normalize-AddonModule $Addon
}

if (-not (Test-Path "$PerfDir/benchmark-perf/node_modules/bare-path/package.json")) {
  Write-Host "==> Installing perf dependencies"
  Push-Location "$PerfDir/benchmark-perf"
  npm install
  Pop-Location
}

if ($Addon -eq "" -or $Judge) {
  if (-not (Test-Path "$PerfDir/node_modules/bare-path/package.json")) {
    Write-Host "==> Installing addon dependencies"
    Push-Location "$PerfDir"
    npm install
    Pop-Location
  }
}

if ($Addon -ne "" -and -not (Is-PathSpec $Addon)) {
  $addonVersion = Get-AddonVersion $Addon
  $addonPath = (Join-Path (Join-Path $PerfDir "benchmark-perf/node_modules") ($AddonModule -replace '/', [System.IO.Path]::DirectorySeparatorChar))
  $packageJson = Join-Path $addonPath "package.json"
  $installAddon = -not (Test-Path $packageJson)
  if (-not $installAddon -and $addonVersion -ne "") {
    $safePath = $packageJson -replace '\\', '\\\\'
    $installedVersion = node -p "require('$safePath').version" 2>$null
    if ($installedVersion -ne $addonVersion) { $installAddon = $true }
  }
  if ($installAddon) {
    Write-Host "==> Installing addon package $Addon"
    Push-Location "$PerfDir/benchmark-perf"
    npm install $Addon
    Pop-Location
  }
}

if ($Addon -eq "") {
  $prebuilds = Get-ChildItem -Path (Join-Path $PerfDir "prebuilds") -Recurse -Filter "qvac__llm-llamacpp*" -ErrorAction SilentlyContinue
  if (-not $prebuilds) {
    Write-Error "Missing prebuilds for local addon. Run 'npm run build' or pass -Addon @qvac/llm-llamacpp@<version>."
    exit 1
  }
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
  $addonArgs += $AddonModule
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
