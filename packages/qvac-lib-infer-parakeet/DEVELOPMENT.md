# Development Guide

This guide provides detailed instructions for developing and contributing to qvac-lib-infer-parakeet.

## Prerequisites

### System Requirements

- **Operating System**: macOS, Linux, Windows, iOS, or Android
- **Node.js/npm**: Version 16 or higher
- **C++ Compiler**: C++20 support required
  - macOS: Xcode Command Line Tools 14+
  - Linux: GCC 11+ or Clang 14+
  - Windows: Visual Studio 2022 with C++ workload
- **Bare Runtime**: Version 2.0.0 or higher

**Note**: You do NOT need to install vcpkg or CMake manually. The `cmake-vcpkg` and `cmake-bare` packages will handle everything automatically.

### Installing Prerequisites

#### macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Install Node.js (if not already installed)
brew install node

# Install Bare runtime
npm install -g bare-runtime
```

#### Linux

```bash
# Install build tools
sudo apt update
sudo apt install -y build-essential git curl

# Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Bare runtime
npm install -g bare-runtime
```

#### Windows

```powershell
# Install Visual Studio 2022 with C++ workload
# Download from: https://visualstudio.microsoft.com/

# Install Node.js from https://nodejs.org/

# Install Bare runtime
npm install -g bare-runtime
```

## Building from Source

### Clone the Repository

```bash
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-parakeet
```

### Build Steps

#### Using npm (Recommended)

```bash
# Install dependencies and build
npm install

# This will:
# 1. Install cmake-bare and cmake-vcpkg
# 2. Run bare-make to generate build files
# 3. Build the native addon
# 4. Install to prebuilds/ directory
```

#### Manual Build

```bash
# Install dependencies first
npm install

# Then build manually
npm run build

# Or step by step:
npx bare-make generate
npx bare-make build
npx bare-make install
```

### Build Options

- **Debug Build**: Use `-DCMAKE_BUILD_TYPE=Debug` for debugging
- **GPU Support**: GPU acceleration is provided via `@qvac/onnx` platform EPs (CoreML, DirectML, NNAPI) — no separate SDK install needed
- **Tests**: Add `-DBUILD_TESTING=ON` to build tests

## Project Structure

```
qvac-lib-infer-parakeet/
├── src/
│   ├── ParakeetModel.hpp         # Model interface declaration
│   ├── ParakeetModel.cpp         # Model implementation with ONNX Runtime
│   ├── binding.cpp               # Bare addon registration and JS bindings
│   └── qvac-lib-inference-addon-cpp/  # Base framework (from dependency)
├── examples/
│   ├── transcribe.js             # Basic transcription example
│   └── README.md                 # Examples documentation
├── scripts/
│   └── download-models.sh        # Model download utility
├── tests/
│   └── parakeet_model_test.cpp   # Unit tests
├── models/                       # Downloaded ONNX models (not in git)
├── build/                        # Build output (not in git)
├── CMakeLists.txt                # Build configuration
├── vcpkg.json                    # C++ dependencies
├── package.json                  # npm package configuration
├── index.js                      # Entry point for require()
├── README.md                     # User documentation
└── DEVELOPMENT.md                # This file
```

## Development Workflow

### 1. Making Code Changes

The main implementation files are:

- **`src/ParakeetModel.cpp`**: Core inference logic, ONNX Runtime integration
- **`src/ParakeetModel.hpp`**: Model interface and configuration
- **`src/binding.cpp`**: JavaScript-C++ bridging

### 2. Rebuilding After Changes

```bash
# Quick rebuild
npm run build

# Or with CMake
cmake --build build --config Release
```

### 3. Testing Your Changes

```bash
# Run the example
npm run example

# Or directly with bare
bare examples/transcribe.js
```

### 4. Running Unit Tests

```bash
# Build with tests
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DBUILD_TESTING=ON

cmake --build build
ctest --test-dir build --output-on-failure
```

## Adding New Features

### Adding a New Model Type

1. **Update `ModelType` enum** in `src/ParakeetModel.hpp`:
   ```cpp
   enum class ModelType {
       CTC, TDT, EOU, SORTFORMER,
       NEW_MODEL_TYPE  // Add here
   };
   ```

2. **Update initialization** in `src/ParakeetModel.cpp`:
   ```cpp
   void ParakeetModel::initializeSession() {
       // Add case for new model
       case ModelType::NEW_MODEL_TYPE:
           modelFile = "new_model.onnx";
           break;
   }
   ```

3. **Update binding** in `src/binding.cpp`:
   ```cpp
   // Add string mapping
   else if (typeStr == "new_type") {
       config.modelType = ModelType::NEW_MODEL_TYPE;
   }
   ```

### Adding Output Event Types

1. **Define event structure** in `src/ParakeetModel.hpp`
2. **Create output handler** in `src/binding.cpp`
3. **Emit events** from `ParakeetModel::process()`

## Debugging

### Enable Debug Logging

Set the ONNX Runtime logging level in `ParakeetModel.cpp`:

```cpp
env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_VERBOSE, "ParakeetModel");
```

### Debug with GDB (Linux/macOS)

```bash
# Build debug version
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build

# Run with GDB
gdb --args bare examples/transcribe.js
```

### Debug with LLDB (macOS)

```bash
lldb -- bare examples/transcribe.js
```

### Debug with Visual Studio (Windows)

1. Open the solution in Visual Studio
2. Set breakpoints in C++ code
3. Debug → Start Debugging

## Common Issues

### Issue: "Model file not found"

**Solution**: Download models first:
```bash
npm run download-models
```

### Issue: "ONNX Runtime not found"

**Solution**: Make sure vcpkg installed it correctly:
```bash
vcpkg list | grep onnx
# Should show: onnxruntime:x64-<platform>
```

### Issue: "undefined symbol" errors

**Solution**: Rebuild with clean cache:
```bash
rm -rf build/
npm run build
```

### Issue: GPU acceleration not working

**Solution**: 
1. Verify your platform has a supported EP: CoreML (macOS/iOS), DirectML (Windows), NNAPI (Android). Linux prebuilds currently run CPU only.
2. Set `useGPU: true` in configuration
3. Check logs for EP registration messages — the addon falls back to CPU if the EP fails

## Performance Optimization

### Tips for Better Performance

1. **Use GPU acceleration** if available (`useGPU: true`)
2. **Adjust thread count** based on your CPU (`maxThreads`)
3. **Use smaller models** on resource-constrained devices (quantized versions)
4. **Batch processing** for multiple audio files
5. **Profile with** `valgrind` (Linux) or Instruments (macOS)

### Profiling

```bash
# Linux: valgrind
valgrind --tool=callgrind bare examples/transcribe.js

# macOS: Instruments
instruments -t "Time Profiler" bare examples/transcribe.js
```

## Contributing

### Code Style

This project uses:
- **C++20** standard features
- **clang-format** for formatting
- **clang-tidy** for linting

Format your code before committing:
```bash
find src -name "*.cpp" -o -name "*.hpp" | xargs clang-format -i
```

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test your changes
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

## Resources

- **ONNX Runtime Documentation**: https://onnxruntime.ai/docs/
- **Bare Runtime**: https://github.com/holepunchto/bare
- **QVAC Framework**: https://github.com/tetherto/qvac-lib-inference-addon-cpp
- **Parakeet Models**: https://github.com/altunene/parakeet-rs

## License

Apache-2.0 License - see [LICENSE](LICENSE) file for details.

Model files are licensed under CC-BY-4.0 by NVIDIA.

