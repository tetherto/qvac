
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
   - **Linux**: LLVM/Clang 19 (with libc++), CMake 3.25+, Vulkan SDK
     ```bash
     # Install LLVM 19
     wget -q https://apt.llvm.org/llvm.sh && chmod +x llvm.sh && sudo ./llvm.sh 19 all

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
   - `bare-make install` - Installs the built addon into `prebuilds/`

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

## Building for Different Platforms

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
