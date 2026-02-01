# Building from source

This section is for developers who want to build the addon locally and contribute to the project.

## Prerequisites for Building

Before building the addon, ensure you have the following installed:

1. **Node.js and npm** (for dependency management)
2. **Bare Runtime** (version 1.17.3 or higher)
   ```bash
   npm install -g bare bare-make
   ```
3. **CMake** (version 3.25 or higher)
4. **vcpkg** (C++ package manager)
5. **Platform-specific build tools:**
   - **macOS**: Xcode Command Line Tools
   - **Linux**: GCC/G++ compiler, build-essential
   - **Windows**: Visual Studio 2022 with C++ workload

## Setting Up vcpkg

The project uses vcpkg for C++ dependency management. Set up vcpkg:

```bash
# Clone vcpkg (if not already installed)
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg

# Bootstrap vcpkg
./bootstrap-vcpkg.sh  # On macOS/Linux
# OR
./bootstrap-vcpkg.bat  # On Windows

# Set environment variable
export VCPKG_ROOT=$(pwd)  # On macOS/Linux
# OR
set VCPKG_ROOT=%cd%  # On Windows
```

## Building the Addon

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tetherto/qvac-lib-infer-onnx-vad.git
   cd qvac-lib-infer-onnx-vad
   ```

2. **Install npm dependencies:**
   ```bash
   npm install
   ```

3. **Build the addon:**
   ```bash
   npm run build
   ```

   This command runs the following sequence:
   - `bare-make generate` - Generates build files using CMake
   - `bare-make build` - Compiles the native C++ addon
   - `bare-make install` - Installs the built addon to the prebuilds directory

## Running Tests

See [tests.md](./tests.md)

## Platform-Specific Build Notes

### macOS
- Ensure Xcode Command Line Tools are installed: `xcode-select --install`
- The build targets Vulkan backend for GPU acceleration

### Linux
- Install required system packages:
  ```bash
  sudo apt-get update
  sudo apt-get install libxi-dev libxtst-dev libxrandr-dev mesa-vulkan-drivers
  ```

### Windows
- Use Visual Studio 2022 with C++ workload
- Enable long paths: `git config --system core.longpaths true`