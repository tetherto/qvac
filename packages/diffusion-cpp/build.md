
# Building from Source

If you want to build the addon from source instead of using pre-built packages, follow these steps:

## Prerequisites for Building

1. **Install Bare** (version >= 1.24.0):
   ```bash
   npm install -g bare
   ```

2. **Install bare-make**:
   ```bash
   npm install -g bare-make
   ```

3. **Install vcpkg and set VCPKG_ROOT**:
   
   This project uses vcpkg for dependency management. You need to install vcpkg and set the `VCPKG_ROOT` environment variable.
   Cloning the repo ensures you get the exact vcpkg version (2025.12.12) that this project uses:
   
   - **macOS/Linux**:
     ```bash
     # Clone vcpkg (use a location outside the project directory)
     cd ~
     git clone --branch 2025.12.12 --single-branch https://github.com/microsoft/vcpkg.git
     cd vcpkg
     
     # Bootstrap vcpkg
     ./bootstrap-vcpkg.sh -disableMetrics
     
     # Set VCPKG_ROOT environment variable (add to your ~/.zshrc or ~/.bashrc for persistence)
     export VCPKG_ROOT=$(pwd)
     ```
   
   - **Windows**:
     ```powershell
     # Clone vcpkg (use a location outside the project directory)
     cd C:\
     git clone --branch 2025.12.12 --single-branch https://github.com/microsoft/vcpkg.git
     cd vcpkg
     
     # Bootstrap vcpkg
     .\bootstrap-vcpkg.bat
     
     # Set VCPKG_ROOT environment variable (for current session)
     $env:VCPKG_ROOT = (Get-Location).Path
     
     # To make it persistent, add it to System Environment Variables or your PowerShell profile
     ```
   
   You can verify it's set by running:
     - macOS/Linux: `echo $VCPKG_ROOT`
     - Windows: `echo $env:VCPKG_ROOT`

4. **Platform-specific requirements**:
   - **macOS**:
     - Xcode Command Line Tools (`xcode-select --install`)
     - Apple clang (LLVM compiler is not supported at the moment)
   - **Linux**: LLVM/Clang 22 (with libc++), CMake 3.25+, Vulkan SDK
     ```bash
     wget -q https://apt.llvm.org/llvm.sh && chmod +x llvm.sh && sudo ./llvm.sh 22 all

     # Install Vulkan SDK
     sudo apt install -y xz-utils
     wget -q -O /tmp/vulkansdk.tar.xz https://sdk.lunarg.com/sdk/download/latest/linux/vulkan_sdk.tar.xz
     mkdir -p ~/vulkan && cd ~/vulkan && tar xf /tmp/vulkansdk.tar.xz --strip-components=1
     export VULKAN_SDK=~/vulkan/x86_64  # or ~/vulkan/aarch64 for ARM64

     # Required dev packages
     sudo apt-get install libxi-dev libxtst-dev libxrandr-dev
     ```
   - **Windows**:
     - Install Visual Studio 2022 with C++ tools, Clang and LLVM tools
     - Install LLVM (e.g. `choco upgrade llvm`)
     - Install Vulkan SDK:
       ```powershell
       # Download and install
       Invoke-WebRequest -Uri "https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-sdk.exe" -OutFile vulkan-sdk.exe
       .\vulkan-sdk.exe --root C:\VulkanSDK --accept-licenses --default-answer --confirm-command install

       # Set environment variable
       $env:VULKAN_SDK = "C:\VulkanSDK"
       ```
   - **All platforms**: Git, CMake 3.25+

## Build Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/tetherto/qvac.git
   cd qvac/packages/diffusion-cpp
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the addon**:
   ```bash
   npm run build
   ```

   This command runs the complete build pipeline:
   - `bare-make generate` - Generates build files and downloads/builds vcpkg dependencies (including `stable-diffusion.cpp` and `ggml`)
   - `bare-make build` - Compiles the native addon
   - `bare-make install` - Installs the built addon into `prebuilds/<host>/` as `qvac__diffusion-cpp-<host>.bare`
   - `npm run link:platform` - Stages that directory as `node_modules/@qvac/diffusion-cpp-<host>`, which is what `binding.js` loads

> **First build note:** The vcpkg step clones and compiles `stable-diffusion.cpp` and `ggml` from source, which can take **5–15 minutes** depending on your machine and internet connection.

## Advanced Build Options

For more control over the build process, you can run the commands individually:

```bash
# Generate build files (with optional flags)
bare-make generate

# Build the addon
bare-make build

# Install the built addon
bare-make install
```

### Build with unit tests

```bash
# Build and run C++ unit tests
npm run test:cpp
```

On Linux, the native test runner uses `test/unit/lsan-libdbus.supp` to ignore
the six allocations left by the system DBus reply during GPU backend probing.
The same leak reproduces in a pre-H3 addon build. The suppression matches only
`_dbus_message_loader_queue_messages`; LeakSanitizer remains enabled for addon
allocations. CTest uses the same suppression. To run `addon-test` directly, set
`LSAN_OPTIONS=suppressions=$PWD/test/unit/lsan-libdbus.supp` from this package
directory.

## Building for Different Platforms

### DGX Spark and RTX 5090 CUDA

CUDA is opt-in: the default Linux source build does not require the CUDA
toolkit. Use `build:cuda` or `-D SD_CUDA=ON` to enable it. The Linux vcpkg
toolchain selects the matching Clang host compiler for nvcc. Linux CI builds
also enable CUDA when setup-cuda exports `QVAC_CUDA_TOOLKIT`, unless tests or
fuzzing are enabled. An explicit `-D SD_CUDA=OFF` overrides this default.

For native Linux ARM64 builds on GB10 or Linux x64 builds on RTX 5090, put
the versioned LLVM executables and the actual CUDA toolkit directory on
PATH so the Linux triplet resolves the intended compilers. Build native
CUDA cubins and install the backend modules alongside the addon:

```bash
export CUDA_PATH=/usr/local/cuda-13.0
export CUDACXX="$CUDA_PATH/bin/nvcc"
export PATH=/usr/lib/llvm-22/bin:$CUDA_PATH/bin:$PATH
export CUDAHOSTCXX=/usr/lib/llvm-22/bin/clang++
export VCPKG_ROOT=/path/to/vcpkg
npm run build:ts
bare-make generate -D SD_CUDA=ON
bare-make build
bare-make install
npm run link:platform
```

Set `CUDA_PATH` to the actual CUDA 13.0.3 installation (nvcc 13.0.88).
The registry port honors `CUDACXX` first, then searches `CUDA_PATH` hints,
the default search including `PATH`, and finally `/usr/local/cuda`. Verify
the selected compiler in the vcpkg logs and ggml `CMakeCache.txt`.
The Linux toolchain supplies nvcc's `-allow-unsupported-compiler` flag for
the newer Clang host compiler. The registry configures the separate ggml
sub-build's architecture list; a top-level `CMAKE_CUDA_ARCHITECTURES` or
`CUDAARCHS` setting does not replace that explicit list.

Ensure `libqvac-diffusion-ggml-cuda.so` is installed under
`prebuilds/linux-arm64/qvac__diffusion-cpp-linux-arm64/` on Spark or
`prebuilds/linux-x64/qvac__diffusion-cpp-linux-x64/` on an x64 PC, and that `ldd`
resolves its CUDA libraries. GPU selection and weight residency are
independent; the CUDA example explicitly sets both to `cuda0`. See the
package README's measured CUDA recipe for assets and generation commands.

The registry uses Fabric's per-platform architecture lists: Linux x64 includes
SM120a, while Linux ARM64 ships only SM121a. See the README's
[CUDA architecture table](README.md#building-from-source) for the full lists.
The existing prebuild workflow enables `SD_CUDA` for both Linux legs and
packages them together; post-artifact validation requires CUDA and Vulkan
modules on each leg before the merged artifact can be published.

The native generation benchmark ran on Bare runtime 1.31.0. Current unit-test
dependencies include `bare-dns`, which requires runtime 1.33.0 or newer;
the package unit/script tests passed on runtime 1.35.0. Use a separate local
tools installation when upgrading the test runtime on a machine with
unrelated Bare services. Verify `bare --version` rather than assuming the
npm launcher package version equals the runtime version.

Native builds (building for the same platform you're running on) work out of the box.

Cross-compilation:

```bash
# Example: Build for Android
bare-make generate --platform android --arch arm64 -D ANDROID_STL=c++_shared
bare-make build
bare-make install

# Example: Build for iOS
bare-make generate --platform ios --arch arm64
bare-make build
bare-make install
```

**Important:** When switching between different platforms or architectures, you should clean the build directory first to avoid configuration conflicts:

```bash
# Clean build directory before switching platforms
rm -rf build
bare-make generate --platform <new-platform> --arch <new-arch>
bare-make build
bare-make install
```

**Supported platforms:** `linux`, `win32`, `darwin`, `android`, `ios`
**Supported architectures:** `x64`, `arm64`

## Troubleshooting Build Issues

- **VCPKG_ROOT env var must be set**: Make sure you've installed vcpkg and set the `VCPKG_ROOT` environment variable to point to your vcpkg installation directory. See the "Install vcpkg and set VCPKG_ROOT" section above.
- **CMake cannot find cmake-bare**: Make sure you installed `bare` (not `bare-runtime`). The `bare` package includes the necessary CMake configuration files.
- **Android cross-compilation fails with "Could NOT find Vulkan (missing: glslc)"**: Install Vulkan shader compiler tools with `brew install shaderc` on macOS.
- **Build is targeting wrong platform**: If you're switching between platforms (e.g., from macOS to iOS) and the build is still targeting the previous platform, clean the build directory first: `rm -rf build` before running `bare-make generate` again.
- **macOS JS code silently crashes**: `bare-make` currently prefers the Homebrew LLVM toolchain when it is installed, which can produce corrupted `prebuilds` binaries that segfault early in JS usage. If you hit this, uninstall or temporarily move your Homebrew LLVM during the build.
