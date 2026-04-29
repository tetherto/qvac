# Stable Diffusion 2.1 — GGUF Q8_0 (2.32 GB, no authentication required).
#
# Source: gpustack/stable-diffusion-v2-1-GGUF (public, no login needed)
# Converted from stabilityai/stable-diffusion-2-1 using stable-diffusion.cpp.
#
# All-in-one file: no separate text encoder or VAE needed.
# Disk: ~2.32 GB    RAM: ~3.5 GB at runtime

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path (Split-Path -Parent $ScriptDir) "models"
$HF = "https://huggingface.co"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Url = "$HF/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf"
$Dest = Join-Path $OutDir "stable-diffusion-v2-1-Q8_0.gguf"

if (Test-Path $Dest) {
    Write-Host "exists: $(Split-Path -Leaf $Dest)"
} else {
    Write-Host "downloading: $(Split-Path -Leaf $Dest)"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Dest -ErrorAction Stop
    Write-Host "done → $OutDir"
}
