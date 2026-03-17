# Cross-Compiling and Running llama.cpp on Android

Guide for building llama.cpp on a Linux desktop and running multimodal (vision+text) inference on an Android device via ADB.

Tested on: Pixel 10 Pro (Tensor G6, ARM64), Ubuntu host, Android NDK r27.2.

## Prerequisites

### Host machine
- Android NDK r27.2+ (set `$ANDROID_NDK_HOME`)
- CMake 3.22+
- ADB with device authorized (`adb devices` shows device)

### Device
- USB debugging enabled (Settings > Developer Options > USB Debugging)
- Sufficient storage on `/sdcard/` for models (2-5 GB per model)

## Method 1: CPU-Only Build

```bash
# Clone llama.cpp (shallow clone to save space)
git clone --depth 1 https://github.com/ggml-org/llama.cpp
cd llama.cpp

# Create build directory
mkdir build-android && cd build-android

# Configure for Android ARM64
cmake .. \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-28 \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_OPENMP=OFF

# Build (adjust -j for your CPU cores)
cmake --build . --config Release -j$(nproc)
```

Key binaries produced:
- `bin/llama-mtmd-cli` — multimodal CLI (vision + text)
- `bin/llama-cli` — text-only CLI
- `lib/libllama.so`, `lib/libggml.so`, etc.

## Method 2: Vulkan (GPU) Build

**WARNING:** Vulkan GPU support depends on the device's GPU. PowerVR GPUs (Pixel 10 Pro) do NOT work with llama.cpp Vulkan shaders — pipeline creation fails for quantized mat-vec operations. Adreno (Qualcomm) and Mali (Samsung/MediaTek) GPUs have better support.

```bash
mkdir build-android-vulkan && cd build-android-vulkan

cmake .. \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-28 \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_VULKAN=ON \
  -DGGML_OPENMP=OFF

cmake --build . --config Release -j$(nproc)
```

### Vulkan C++ Header Issue

The Android NDK only ships C Vulkan headers (`vulkan/vulkan.h`), not the C++ wrapper (`vulkan/vulkan.hpp`). If the build fails with missing `vulkan.hpp`:

1. Check NDK's Vulkan version:
   ```bash
   grep VK_HEADER_VERSION $ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/vulkan/vulkan_core.h
   ```

2. Download matching C++ headers from KhronosGroup (must match the NDK version exactly):
   ```bash
   # Example for Vulkan 1.3.275 (NDK r27.2)
   NDK_SYSROOT=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/include/vulkan

   curl -L -o $NDK_SYSROOT/vulkan.hpp \
     "https://raw.githubusercontent.com/KhronosGroup/Vulkan-Headers/v1.3.275/include/vulkan/vulkan.hpp"
   curl -L -o $NDK_SYSROOT/vulkan_raii.hpp \
     "https://raw.githubusercontent.com/KhronosGroup/Vulkan-Headers/v1.3.275/include/vulkan/vulkan_raii.hpp"
   # ... and other missing .hpp files as needed
   ```

   **Do NOT use host `/usr/include/vulkan/` headers** — version mismatch causes `static assertion failed: Wrong VK_HEADER_VERSION!`, and non-Vulkan host headers (like `bits/wordsize.h`) will break the cross-compilation.

## Pushing Files to Device

### Binaries — must go to `/data/local/tmp/` (executable)

```bash
DEVICE_BIN=/data/local/tmp/llama-bench

adb shell mkdir -p $DEVICE_BIN

# Push binary
adb push bin/llama-mtmd-cli $DEVICE_BIN/

# Push shared libraries
adb push lib/libllama.so $DEVICE_BIN/
adb push lib/libggml.so $DEVICE_BIN/
adb push lib/libggml-base.so $DEVICE_BIN/
adb push lib/libggml-cpu.so $DEVICE_BIN/
# For Vulkan builds also push:
adb push lib/libggml-vulkan.so $DEVICE_BIN/

# Make binary executable
adb shell chmod +x $DEVICE_BIN/llama-mtmd-cli
```

**IMPORTANT:** `/sdcard/` is mounted `noexec` — binaries cannot run from there. Always use `/data/local/tmp/` for executables.

### Models and images — can go to `/sdcard/` (read-only access is fine)

```bash
DEVICE_MODELS=/sdcard/llama-bench

adb shell mkdir -p $DEVICE_MODELS
adb push MyModel-Q8_0.gguf $DEVICE_MODELS/
adb push mmproj-F16.gguf $DEVICE_MODELS/
adb push test_image.png $DEVICE_MODELS/
```

## Running Inference

### Basic multimodal (vision + text) command

```bash
adb shell "LD_LIBRARY_PATH=/data/local/tmp/llama-bench \
  /data/local/tmp/llama-bench/llama-mtmd-cli \
  -m /sdcard/llama-bench/Model-Q8_0.gguf \
  --mmproj /sdcard/llama-bench/mmproj-F16.gguf \
  --image /sdcard/llama-bench/test_image.png \
  -p 'Extract all text from this image and format it as markdown.' \
  -ngl 0 -c 4096 --temp 0.1 -n 2048 --jinja"
```

Key flags:
- `-ngl 0` — CPU-only (use `-ngl 99` for GPU offload if Vulkan works)
- `-c 4096` — context size (reduce to 2048 if OOM-killed)
- `--temp 0.1` — low temperature for deterministic OCR output
- `-n 2048` — max tokens to generate
- `--jinja` — required for Qwen3.5 models (custom chat template)
- `LD_LIBRARY_PATH` — must point to directory with .so files

### Text-only command

```bash
adb shell "LD_LIBRARY_PATH=/data/local/tmp/llama-bench \
  /data/local/tmp/llama-bench/llama-cli \
  -m /sdcard/llama-bench/Model-Q8_0.gguf \
  -p 'Hello, how are you?' \
  -ngl 0 -c 2048 --temp 0.7 -n 256"
```

## Reading Performance Metrics

llama.cpp prints performance stats at the end of each run:

```
llama_perf_context_print: prompt eval time = 15000.00 ms / 794 tokens (18.89 ms/token, 52.93 tokens/s)
llama_perf_context_print:        eval time = 354000.00 ms / 849 runs  (416.96 ms/token, 2.40 tokens/s)
llama_perf_context_print:       total time = 371000.00 ms / 1643 tokens
```

- **prompt eval** = prefill speed (processing input + image tokens)
- **eval** = generation speed (tokens per second for output)
- **Image encoding** = printed earlier as `image slice encoded in XXX ms`
