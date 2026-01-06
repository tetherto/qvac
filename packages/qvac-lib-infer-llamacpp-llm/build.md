
# Building from Source

If you want to build the addon from source instead of using pre-built packages, follow these steps:

## Prerequisites for Building

1. **Install Bare** (version >= 1.19.0):
   ```bash
   npm install -g bare
   ```

2. **Install bare-make**:
   ```bash
   npm install -g bare-make
   ```

3. **Platform-specific requirements**:
   - **macOS**: 
     - Xcode Command Line Tools
     - For Android cross-compilation: Android NDK and Vulkan tools (`brew install shaderc vulkan-tools molten-vk vulkan-headers`)
   - **Linux**: GCC/G++ compiler, CMake
   - **Windows**:  
      - Install Visual Studio 2022 with C++ tools, Clang and llvm tools
      - Install Vulkan
          - Download [Vulkan installer]( https://sdk.lunarg.com/sdk/download/latest/windows/vulkan-sdk.exe)
          - Install Vulkan
            ```bash
            ./vulkansdk-windows-X64-1.4.321.1.exe --root C:\VulkanSDK --accept-licenses --default-answer --confirm-command install
            ```
          - Add Vulkan installation path in `VULKAN_SDK` env variable
            ```bash
            powershell
            $env:VULKAN_SDK="C:\VulkanSDK"
            cmd
            set VULKAN_SDK="C:\VulkanSDK"
            ```
   - **All platforms**: Git (for submodule initialization)

## Build Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/tetherto/qvac-lib-infer-llamacpp-llm.git
   cd qvac-lib-infer-llamacpp-llm
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
   - `bare-make generate` - Generates build files
   - `bare-make build` - Compiles the native addon
   - `bare-make install` - Installs the built addon

## Advanced Build Options

For more control over the build process, you can run the commands individually:

```bash
# Generate build files (with optional flags)
bare-make generate

# For building with BERT model support (used in tests)
bare-make generate -D BUILD_BERT_MODEL=ON

# Build the addon
bare-make build

# Install the built addon
bare-make install
```

## Cross-compilation

To build for different platforms/architectures:

```bash
# Example: Build for Linux ARM64
bare-make generate --platform linux --arch arm64
bare-make build
bare-make install

# Example: Build for Windows x64
bare-make generate --platform win32 --arch x64
bare-make build
bare-make install
```

## Troubleshooting Build Issues

- **CMake cannot find cmake-bare**: Make sure you installed `bare` (not `bare-runtime`). The `bare` package includes the necessary CMake configuration files.
- **Android cross-compilation fails with "Could NOT find Vulkan (missing: glslc)"**: Install Vulkan shader compiler tools with `brew install shaderc` on macOS.
