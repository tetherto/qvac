<#
.SYNOPSIS
    Windows Build Script for qvac-lib-infer-nmtcpp

.DESCRIPTION
    This script automates the build process for qvac-lib-infer-nmtcpp on Windows.
    It handles prerequisite checking, submodule initialization, patch application,
    and the full CMake build process using bare-make.

.PARAMETER Platform
    Target platform (default: win32)

.PARAMETER Arch
    Target architecture (default: x64)

.PARAMETER VcpkgRoot
    Path to vcpkg installation. Can also be set via VCPKG_ROOT environment variable.

.PARAMETER SkipDeps
    Skip npm dependency installation

.PARAMETER SkipSubmodules
    Skip git submodule initialization (use if already initialized)

.PARAMETER Clean
    Clean build and prebuilds directories before building

.PARAMETER Help
    Display this help message

.EXAMPLE
    .\scripts\build_win.ps1
    Basic build with default settings. Requires VCPKG_ROOT environment variable.

.EXAMPLE
    .\scripts\build_win.ps1 -VcpkgRoot "path\to\vcpkg"
    Build with explicit vcpkg path.

.EXAMPLE
    .\scripts\build_win.ps1 -SkipSubmodules
    Build without re-initializing submodules (faster if already done).

.EXAMPLE
    .\scripts\build_win.ps1 -Clean -VcpkgRoot "path\to\vcpkg"
    Clean build from scratch.

.EXAMPLE
    .\scripts\build_win.ps1 -SkipDeps -SkipSubmodules
    Quick rebuild skipping dependency and submodule steps.

.NOTES
    Prerequisites:
    - Node.js 18+
    - CMake 3.25+
    - Visual Studio 2022 (Build Tools)
    - Git
    - vcpkg (set VCPKG_ROOT or use -VcpkgRoot parameter)

    The bare-runtime will be installed automatically if not present.

    Build output will be placed in: prebuilds/<platform>-<arch>/
#>

param(
    [string]$Platform = "win32",
    [string]$Arch = "x64",
    [string]$VcpkgRoot = "",
    [switch]$SkipDeps = $false,
    [switch]$SkipSubmodules = $false,
    [switch]$Clean = $false,
    [switch]$Help = $false
)

$ErrorActionPreference = "Stop"

# Show help if requested
if ($Help) {
    Write-Host @"
NAME
    build_win.ps1

SYNOPSIS
    Windows Build Script for qvac-lib-infer-nmtcpp

DESCRIPTION
    This script automates the build process for qvac-lib-infer-nmtcpp on Windows.
    It handles prerequisite checking, submodule initialization, patch application,
    and the full CMake build process using bare-make.

SYNTAX
    .\scripts\build_win.ps1 [[-Platform] <String>] [[-Arch] <String>] [[-VcpkgRoot] <String>]
                    [-SkipDeps] [-SkipSubmodules] [-Clean] [-Help]

PARAMETERS
    -Platform <String>
        Target platform (default: win32)

    -Arch <String>
        Target architecture (default: x64)

    -VcpkgRoot <String>
        Path to vcpkg installation. Can also be set via VCPKG_ROOT environment variable.

    -SkipDeps
        Skip npm dependency installation

    -SkipSubmodules
        Skip git submodule initialization (use if already initialized)

    -Clean
        Clean build and prebuilds directories before building

    -Help
        Display this help message

EXAMPLES
    .\scripts\build_win.ps1
        Basic build with default settings. Requires VCPKG_ROOT environment variable.

    .\scripts\build_win.ps1 -VcpkgRoot "path\to\vcpkg"
        Build with explicit vcpkg path.

    .\scripts\build_win.ps1 -SkipSubmodules
        Build without re-initializing submodules (faster if already done).

    .\scripts\build_win.ps1 -Clean
        Clean build from scratch.

    .\scripts\build_win.ps1 -SkipDeps -SkipSubmodules
        Quick rebuild skipping dependency and submodule steps.

PREREQUISITES
    - Node.js 18+
    - CMake 3.25+
    - Visual Studio 2022 (Build Tools)
    - Git
    - vcpkg (set VCPKG_ROOT or use -VcpkgRoot parameter)

    The bare-runtime will be installed automatically if not present.

OUTPUT
    Build output will be placed in: prebuilds/<platform>-<arch>/
"@
    exit 0
}

# Get the project root directory (parent of scripts/)
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PatchesDir = Join-Path $ProjectRoot "patches"

# Change to project root directory
Push-Location $ProjectRoot

try {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Windows Build Script" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    # Function to check if a command exists
    function Test-Command {
        param([string]$Command)
        $null = Get-Command $Command -ErrorAction SilentlyContinue
        return $?
    }

    # Check prerequisites
    Write-Host "Checking prerequisites..." -ForegroundColor Yellow

    # Check Node.js (npm comes bundled with Node.js)
    if (-not (Test-Command "node")) {
        Write-Host "ERROR: Node.js is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Please install Node.js 18+ from https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js: $(node --version)" -ForegroundColor Green

    # Check bare runtime
    if (-not (Test-Command "bare")) {
        Write-Host "  bare: Not found, will install..." -ForegroundColor Yellow
        npm install -g bare-runtime
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install bare-runtime" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "  bare: $(bare --version)" -ForegroundColor Green

    # Check CMake
    if (-not (Test-Command "cmake")) {
        Write-Host "ERROR: CMake is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Please install CMake 3.25+ from https://cmake.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  CMake: $(cmake --version | Select-Object -First 1)" -ForegroundColor Green

    # Check Visual Studio Build Tools
    $vsPaths = @(
        "${env:ProgramFiles}\Microsoft Visual Studio\2022",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022"
    )
    $vsFound = $false
    foreach ($vsPath in $vsPaths) {
        if (Test-Path $vsPath) {
            Write-Host "  Visual Studio 2022: Found" -ForegroundColor Green
            $vsFound = $true
            break
        }
    }
    if (-not $vsFound) {
        Write-Host "  Visual Studio 2022: Not found" -ForegroundColor Yellow
    }

    # Check Git (required for submodules)
    if (-not (Test-Command "git")) {
        Write-Host "ERROR: Git is not installed or not in PATH" -ForegroundColor Red
        Write-Host "Git is required for submodule initialization" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Git: $(git --version)" -ForegroundColor Green

    Write-Host ""
    Write-Host "Prerequisites check complete!" -ForegroundColor Green
    Write-Host ""

    # Use VCPKG_ROOT from environment or parameter
    if ($VcpkgRoot) {
        $env:VCPKG_ROOT = $VcpkgRoot
    }

    if (-not $env:VCPKG_ROOT -or -not (Test-Path $env:VCPKG_ROOT)) {
        Write-Host "ERROR: VCPKG_ROOT is not set or invalid" -ForegroundColor Red
        Write-Host "Please set VCPKG_ROOT environment variable or use -VcpkgRoot parameter" -ForegroundColor Red
        Write-Host "Example: `$env:VCPKG_ROOT = 'C:\path\to\vcpkg'" -ForegroundColor Yellow
        Write-Host "    or: .\scripts\build.ps1 -VcpkgRoot 'C:\path\to\vcpkg'" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Using VCPKG_ROOT: $env:VCPKG_ROOT" -ForegroundColor Cyan
    Write-Host ""

    # Clean build directory if requested
    if ($Clean) {
        Write-Host "Cleaning build directory..." -ForegroundColor Yellow
        if (Test-Path "build") {
            Remove-Item -Recurse -Force "build"
            Write-Host "  Build directory cleaned" -ForegroundColor Green
        }
        if (Test-Path "prebuilds") {
            Remove-Item -Recurse -Force "prebuilds"
            Write-Host "  Prebuilds directory cleaned" -ForegroundColor Green
        }
        Write-Host ""
    }

    # Check config.cmake exists with required settings
    Write-Host "Checking config.cmake for Bergamot backend..." -ForegroundColor Yellow
    if (-not (Test-Path "config.cmake")) {
        $configContent = @"
# Auto-generated by build_win.ps1
set(USE_BERGAMOT ON CACHE BOOL "Enable Bergamot backend support" FORCE)
set(USE_INTGEMM ON CACHE BOOL "Use INTGEMM for int8 quantized models" FORCE)
"@
        Set-Content -Path "config.cmake" -Value $configContent
        Write-Host "  config.cmake created (USE_BERGAMOT=ON)" -ForegroundColor Green
    } else {
        Write-Host "  config.cmake already exists, skipping" -ForegroundColor Gray
    }
    Write-Host ""

    # Install npm dependencies
    if (-not $SkipDeps) {
        Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: Failed to install npm dependencies" -ForegroundColor Red
            exit 1
        }
        Write-Host "  Dependencies installed" -ForegroundColor Green
        Write-Host ""
    }

    # Initialize git submodules
    if (-not $SkipSubmodules) {
        Write-Host "Initializing git submodules..." -ForegroundColor Yellow
        git submodule update --init --recursive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARNING: Some submodules may have failed to initialize" -ForegroundColor Yellow
            Write-Host "  This may be due to Windows path length limitations" -ForegroundColor Yellow
            Write-Host "  Attempting to continue..." -ForegroundColor Yellow
        }
        Write-Host "  Submodules initialized" -ForegroundColor Green
        Write-Host ""
    }

    # Reset submodules to clean state before applying patches
    Write-Host "Resetting submodules to clean state..." -ForegroundColor Yellow
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    git submodule foreach --recursive "git checkout -- ." 2>$null
    $ErrorActionPreference = $oldErrorAction
    Write-Host "  Submodules reset" -ForegroundColor Green
    Write-Host ""

    # Apply patches using git apply
    Write-Host "Applying patches..." -ForegroundColor Yellow

    # Helper function to apply a patch
    function Apply-Patch {
        param(
            [string]$PatchFile,
            [string]$TargetDir,
            [string]$Description
        )
        
        $patchPath = Join-Path $PatchesDir $PatchFile
        if (-not (Test-Path $patchPath)) {
            Write-Host "  $Description : Patch file not found" -ForegroundColor Yellow
            return
        }
        
        Push-Location $TargetDir
        # Temporarily disable error handling for git commands (they output to stderr)
        $oldErrorAction = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        try {
            # Check if patch is already applied by doing a dry run with --reverse
            $null = git apply --check --reverse $patchPath 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  $Description : Already applied" -ForegroundColor Gray
                $ErrorActionPreference = $oldErrorAction
                Pop-Location
                return
            }
            
            # Try to apply the patch
            $null = git apply --check $patchPath 2>&1
            if ($LASTEXITCODE -eq 0) {
                $null = git apply $patchPath 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "  $Description : Applied" -ForegroundColor Green
                } else {
                    Write-Host "  $Description : Failed to apply" -ForegroundColor Red
                }
            } else {
                Write-Host "  $Description : Cannot apply (may conflict)" -ForegroundColor Yellow
            }
        } finally {
            $ErrorActionPreference = $oldErrorAction
            Pop-Location
        }
    }

    # Base paths
    $bergamotDir = "third-party/bergamot-translator"
    $marianDir = "$bergamotDir/3rd_party/marian-dev"
    $ssplitDir = "$bergamotDir/3rd_party/ssplit-cpp"

    # Apply patches for bergamot-translator
    Apply-Patch "fix-bergamot-clang-cl.patch" $bergamotDir "Fix bergamot-translator clang-cl LTCG"

    # Apply patches for marian-dev
    Apply-Patch "fix-marian-clang-cl.patch" $marianDir "Fix marian-dev clang-cl LTCG/SIMD"
    # C++20 patches ARE required because bare-make overrides the C++ standard to C++20
    # std::result_of was removed in C++20, so we need to replace it with std::invoke_result
    Apply-Patch "fix-threadpool-cpp20.patch" $marianDir "Fix threadpool std::result_of C++20"
    Apply-Patch "fix-cli-app-cpp20.patch" $marianDir "Fix CLI/App.hpp std::result_of C++20"

    # Apply patches for marian-dev submodules
    Apply-Patch "fix-fbgemm-clang-cl.patch" "$marianDir/src/3rd_party/fbgemm" "Fix fbgemm clang-cl LTCG"
    Apply-Patch "fix-intgemm-clang-cl.patch" "$marianDir/src/3rd_party/intgemm" "Fix intgemm clang-cl warnings"
    Apply-Patch "fix-clog-cmake-version.patch" "$marianDir/src/3rd_party/ruy/third_party/cpuinfo" "Fix clog CMake version"
    Apply-Patch "fix-sentencepiece-cmake-version.patch" "$marianDir/src/3rd_party/sentencepiece" "Fix sentencepiece CMake version"

    # Apply patches for ssplit-cpp
    Apply-Patch "fix-ssplit-pcre2-static.patch" $ssplitDir "Fix ssplit PCRE2_STATIC define"
    Apply-Patch "fix-findpcre2-cmake.patch" $ssplitDir "Fix FindPCRE2.cmake cross-compile"

    Write-Host "  Patches complete" -ForegroundColor Green
    Write-Host ""

    # Fallback fixes: Apply directly if patches failed
    Write-Host "Applying fallback fixes..." -ForegroundColor Yellow

    # Fix 1: marian-dev LTCG/SIMD for clang-cl
    $marianCMakePath = Join-Path $ProjectRoot "$marianDir/CMakeLists.txt"
    $marianContent = Get-Content $marianCMakePath -Raw
    $marianModified = $false

    # Add IS_CLANG_CL detection if missing
    if ($marianContent -notmatch 'IS_CLANG_CL') {
        Write-Host "  Adding IS_CLANG_CL detection..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace `
            '(if\(MSVC\)\r?\n)(# These are used)', `
'$1  # Check if using clang-cl
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    set(IS_CLANG_CL TRUE)
  else()
    set(IS_CLANG_CL FALSE)
  endif()

$2'
        $marianModified = $true
    }

    # Remove LTCG flags
    if ($marianContent -match '/LTCG:incremental') {
        Write-Host "  Removing LTCG flags..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace '/LTCG:incremental ?', ''
        $marianModified = $true
    }

    # Remove /MP /GL flags (not supported by clang-cl)
    if ($marianContent -match '/MP /GL ') {
        Write-Host "  Removing /MP /GL flags..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace '/MP /GL ', ''
        $marianModified = $true
    }

    # Add INTRINSICS override for clang-cl (SSE4.1/SSE3 support via AVX)
    if ($marianContent -notmatch 'if\(IS_CLANG_CL\)\s+set\(INTRINSICS "/arch:AVX"\)') {
        Write-Host "  Adding INTRINSICS /arch:AVX for clang-cl..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace `
            '(set\(INTRINSICS \$\{MSVC_BUILD_ARCH\}\)\r?\n  # set\(INTRINSICS "/arch:AVX512"\))', `
'$1

  # For clang-cl: ensure AVX is used (includes SSE4.1, SSSE3, SSE3)
  if(IS_CLANG_CL)
    set(INTRINSICS "/arch:AVX")
  endif()'
        $marianModified = $true
    }

    # Fix /WX for clang-cl (warnings as errors)
    if ($marianContent -match 'list\(APPEND ALL_WARNINGS /WX; /W4;\)' -and $marianContent -notmatch 'if\(IS_CLANG_CL\)\s+list\(APPEND ALL_WARNINGS /W4;\)') {
        Write-Host "  Fixing /WX for clang-cl..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace `
            'list\(APPEND ALL_WARNINGS /WX; /W4;\)', `
'# /WX treats warnings as errors - disable for clang-cl
  if(IS_CLANG_CL)
    list(APPEND ALL_WARNINGS /W4;)
  else()
    list(APPEND ALL_WARNINGS /WX; /W4;)
  endif()'
        $marianModified = $true
    }

    # Add _SILENCE_CXX17 definitions for clang-cl
    if ($marianContent -notmatch '_SILENCE_CXX17_ITERATOR_BASE_CLASS_DEPRECATION_WARNING') {
        Write-Host "  Adding _SILENCE_CXX17 definitions..." -ForegroundColor Yellow
        $marianContent = $marianContent -replace `
            '(set\(CMAKE_CXX_FLAGS\s+"/EHsc /DWIN32[^"]+"\))\r?\n(\s+set\(CMAKE_CXX_FLAGS_RELEASE)', `
'$1
  # Silence C++17 deprecation warnings for clang-cl
  if(IS_CLANG_CL)
    add_compile_definitions(_SILENCE_CXX17_ITERATOR_BASE_CLASS_DEPRECATION_WARNING)
    add_compile_definitions(_SILENCE_ALL_CXX17_DEPRECATION_WARNINGS)
  endif()
$2'
        $marianModified = $true
    }

    if ($marianModified) {
        Set-Content $marianCMakePath $marianContent -NoNewline
        Write-Host "  marian-dev clang-cl fixes: Applied" -ForegroundColor Green
    } else {
        Write-Host "  marian-dev clang-cl fixes: Already applied" -ForegroundColor Gray
    }

    # Fix 2: threadpool.h std::result_of -> std::invoke_result_t (C++20)
    $threadpoolPath = Join-Path $ProjectRoot "$marianDir/src/3rd_party/threadpool.h"
    $threadpoolContent = Get-Content $threadpoolPath -Raw
    if ($threadpoolContent -match 'std::result_of') {
        Write-Host "  Fixing threadpool.h C++20 compatibility..." -ForegroundColor Yellow
        $threadpoolContent = $threadpoolContent -replace `
            'std::future<typename std::result_of<F\(Args\.\.\.\)>::type>', `
            'std::future<std::invoke_result_t<F, Args...>>'
        $threadpoolContent = $threadpoolContent -replace `
            'using return_type = typename std::result_of<F\(Args\.\.\.\)>::type;', `
            'using return_type = std::invoke_result_t<F, Args...>;'
        Set-Content $threadpoolPath $threadpoolContent -NoNewline
        Write-Host "  threadpool.h C++20: Fixed" -ForegroundColor Green
    } else {
        Write-Host "  threadpool.h C++20: Already fixed" -ForegroundColor Gray
    }

    # Fix 3: CLI/App.hpp std::result_of -> std::invoke_result_t (C++20)
    $appHppPath = Join-Path $ProjectRoot "$marianDir/src/3rd_party/CLI/App.hpp"
    $appHppContent = Get-Content $appHppPath -Raw
    if ($appHppContent -match 'std::result_of') {
        Write-Host "  Fixing CLI/App.hpp C++20 compatibility..." -ForegroundColor Yellow
        $appHppContent = $appHppContent -replace `
            'typename std::result_of<decltype \(&App::_parse_arg\)\(App, Args\.\.\.\)>::type', `
            'std::invoke_result_t<decltype (&App::_parse_arg), App, Args...>'
        $appHppContent = $appHppContent -replace `
            'typename std::result_of<decltype \(&App::_parse_subcommand\)\(App, Args\.\.\.\)>::type', `
            'std::invoke_result_t<decltype (&App::_parse_subcommand), App, Args...>'
        Set-Content $appHppPath $appHppContent -NoNewline
        Write-Host "  CLI/App.hpp C++20: Fixed" -ForegroundColor Green
    } else {
        Write-Host "  CLI/App.hpp C++20: Already fixed" -ForegroundColor Gray
    }

    Write-Host "  Fallback fixes complete" -ForegroundColor Green
    Write-Host ""

    # Generate build files
    Write-Host "Generating build files..." -ForegroundColor Yellow
    Write-Host "  Platform: $Platform, Arch: $Arch" -ForegroundColor Cyan

    bare-make generate --platform $Platform --arch $Arch
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to generate build files" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Build files generated" -ForegroundColor Green
    Write-Host ""

    # Build the project
    Write-Host "Building project (this may take 10-15 minutes)..." -ForegroundColor Yellow

    bare-make build
    if ($LASTEXITCODE -ne 0) {
        # Check if it's the pcre2 library name issue
        $pcre2Static = "build/lib/pcre2-8-static.lib"
        $pcre2Expected = "build/lib/pcre2-8.lib"
        if ((Test-Path $pcre2Static) -and -not (Test-Path $pcre2Expected)) {
            Write-Host "  Fixing pcre2 library name..." -ForegroundColor Yellow
            Copy-Item $pcre2Static $pcre2Expected
            Write-Host "  Retrying build..." -ForegroundColor Yellow
            bare-make build
            if ($LASTEXITCODE -ne 0) {
                Write-Host "ERROR: Build failed" -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "ERROR: Build failed" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "  Build completed" -ForegroundColor Green
    Write-Host ""

    # Install prebuilds
    Write-Host "Installing prebuilds..." -ForegroundColor Yellow
    bare-make install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install prebuilds" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Prebuilds installed" -ForegroundColor Green
    Write-Host ""

    # Success
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Build completed successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Prebuilds: prebuilds/$Platform-$Arch/" -ForegroundColor Cyan
    Write-Host ""

} finally {
    # Always return to original directory
    Pop-Location
}

