vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-fabric-llm.cpp
  REF c0cea41c58b667624d247c26d45d3a0bcafcae98
  SHA512 ec2a87f3115d6aeac6eba14106cda10a0626397ecd714eb7b05dcebe22296aca59d0ab19021eb2c9983762e99853ea215752209614ca5d1becf1d09df028b329
)

# Upstream CMake options only, passed through to vcpkg_cmake_configure.
vcpkg_check_features(
  OUT_FEATURE_OPTIONS FEATURE_OPTIONS
  FEATURES
    force-profiler FORCE_GGML_VK_PERF_LOGGER
    llama BUILD_LLAMA
    vector-index GGML_VECTOR_INDEX
)

# Portfile-only feature flags (drive PLATFORM_OPTIONS; not upstream cache vars).
vcpkg_check_features(
  OUT_FEATURE_OPTIONS _PORTFILE_FEATURE_OPTIONS
  FEATURES
    gpu-backends BUILD_GPU_BACKENDS
    kleidiai BUILD_KLEIDIAI
    openmp BUILD_OPENMP
    hip-backend BUILD_HIP_BACKEND
    cuda-backend BUILD_CUDA_BACKEND
    cuda-jetson-backend BUILD_CUDA_JETSON_BACKEND
    rpc-server BUILD_RPC_SERVER
    rpc-rdma BUILD_RPC_RDMA
)

if(BUILD_CUDA_JETSON_BACKEND AND NOT BUILD_CUDA_BACKEND)
  message(FATAL_ERROR "qvac-fabric: cuda-jetson-backend requires cuda-backend")
endif()

# gpu-backends is default-on via default-features in vcpkg.json. CPU-only
# consumers (e.g. @qvac/classification-ggml) disable it with
# default-features:false (and re-add 'llama' if needed).
if(NOT BUILD_GPU_BACKENDS)
  message(STATUS "qvac-fabric: gpu-backends feature OFF, building CPU-only ggml (no Metal/Vulkan/CUDA/OpenCL)")
endif()

set(PLATFORM_OPTIONS)

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  # The Android NDK ships only the C Vulkan headers; the ggml Vulkan backend
  # additionally needs the C++ bindings (vulkan.hpp) and SPIRV-Headers, which as
  # of b9840 ggml fetches itself via FetchContent (ggml/src/ggml-vulkan/CMakeLists.txt,
  # `if (ANDROID)` block). The registry vcpkg-cmake sets FETCHCONTENT_FULLY_DISCONNECTED=ON
  # globally, so allow the fetch here (same as the kleidiai path below).
  list(APPEND PLATFORM_OPTIONS -DFETCHCONTENT_FULLY_DISCONNECTED=OFF)
endif()

if(NOT BUILD_GPU_BACKENDS)
  # Force every GPU backend off explicitly, in case upstream defaults change.
  list(APPEND PLATFORM_OPTIONS
    -DGGML_METAL=OFF
    -DGGML_VULKAN=OFF
    -DGGML_CUDA=OFF
    -DGGML_OPENCL=OFF
  )
  if (VCPKG_TARGET_IS_IOS)
    # Same iOS BLAS/Accelerate gating as the GPU-on path; unrelated to the
    # CPU-vs-GPU split, an iOS-toolchain workaround for missing frameworks.
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
elseif (VCPKG_TARGET_IS_OSX OR VCPKG_TARGET_IS_IOS)
  list(APPEND PLATFORM_OPTIONS -DGGML_METAL=ON)
  if (VCPKG_TARGET_IS_IOS)
    list(APPEND PLATFORM_OPTIONS -DGGML_BLAS=OFF -DGGML_ACCELERATE=OFF)
  endif()
else()
  list(APPEND PLATFORM_OPTIONS -DGGML_VULKAN=ON)
endif()

# Android: always build CPU variants (NEON_DOTPROD, NEON_I8MM, etc.) and CPU
# repacking. These are CPU-only runtime optimizations selected based on the
# device's SIMD capabilities at load time, completely orthogonal to the GPU
# backends. Bundling them is essential for good CPU inference performance on
# the wide range of arm64 devices the addons ship to. Requires GGML_BACKEND_DL
# to dispatch the variants at runtime; the existing #ifdef guard around
# `ggml_backend_load_all_from_path()` in ggml-backend-reg.cpp keeps the search
# scoped to the consumer's own prebuilds dir.
# Desktop Linux and Windows also need GGML_BACKEND_DL=ON so that GPU backends
# and CPU variants are runtime-loaded modules. This keeps optional backend DLL
# dependencies out of the core Windows module and lets CPU variant scoring pick
# the best instruction set at runtime.
if(VCPKG_TARGET_IS_ANDROID OR ((VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_WINDOWS) AND BUILD_GPU_BACKENDS))
  # Without DL, the desktop build links a single static GPU backend and a
  # second backend cannot be stacked.
  # GGML_NATIVE is incompatible with DL, so CPU variants are dispatched via
  # GGML_CPU_ALL_VARIANTS instead. Consumers must ship the core ggml/llama libs
  # alongside their backend modules so the dynamically-linked .bare can resolve
  # them at load time.
  set(DL_BACKENDS ON)
  list(APPEND PLATFORM_OPTIONS
    -DGGML_BACKEND_DL=ON
    -DGGML_CPU_ALL_VARIANTS=ON
    -DGGML_CPU_REPACK=ON)
else()
  set(DL_BACKENDS OFF)
endif()

if(VCPKG_TARGET_IS_WINDOWS AND BUILD_GPU_BACKENDS AND BUILD_CUDA_BACKEND)
  set(DL_BACKENDS ON)
  list(APPEND PLATFORM_OPTIONS -DGGML_BACKEND_DL=ON)
endif()

# HIP/ROCm backend is opt-in via the 'hip-backend' feature (Linux + AMD only).
# Only @qvac/vla-ggml requests it, so every other consumer builds with no HIP
# and gains no ROCm dependency. Builds libqvac-ggml-hip.so as a standalone DL
# module alongside Vulkan (GGML_BACKEND_DL is already ON above), so the addon
# dlopen's whichever GPU backend BackendSelection picks at runtime. The `hip`
# feature-dependency port forwards the system ROCm's find_package() configs.
#
# FAIL-SAFE: enable GGML_HIP only when a ROCm SDK is actually present. On a build
# host without ROCm we skip HIP and build Vulkan/CPU only. The build never
# hard-fails, and at runtime a missing HIP module just isn't loaded (the DL
# loader skips it) so BackendSelection falls back to Vulkan/CPU. Targets gfx1151
# (Strix Halo / Radeon 8060S); the HIP compiler + ROCM_PATH come from the build env.
# linux-x64 only: AMD GPU hosts (Strix Halo / gfx1151) are x86_64, and the ROCm
# dist is x64. On other arches (e.g. linux-arm64) HIP is skipped even if the
# feature is requested, with no ROCm requirement or build break.
if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64" AND BUILD_GPU_BACKENDS AND BUILD_HIP_BACKEND)
  # DETERMINISTIC: requesting hip-backend REQUIRES a ROCm SDK at build time. We
  # must NOT silently skip when ROCm is absent. A host-dependent skip yields a
  # no-HIP package with the SAME vcpkg ABI as a real HIP build, which the binary
  # cache then conflates (cache poisoning: a no-ROCm build caches a no-HIP
  # package that ROCm-equipped builds then restore). So ROCm present => HIP;
  # ROCm absent => hard error (don't request hip-backend on a host without ROCm).
  # The RUNTIME fail-safe is unchanged: an absent HIP module / non-AMD target is
  # simply not loaded and BackendSelection falls back to Vulkan/CPU.
  if(NOT (DEFINED ENV{ROCM_PATH} AND EXISTS "$ENV{ROCM_PATH}/lib/cmake/hip/hip-config.cmake"))
    message(FATAL_ERROR "qvac-fabric: hip-backend feature requires a ROCm SDK. Set ROCM_PATH to a ROCm/TheRock install containing lib/cmake/hip/hip-config.cmake. Do not request hip-backend on a host without ROCm.")
  endif()
  message(STATUS "qvac-fabric: hip-backend ON, building GGML_HIP (gfx1151)")
  list(APPEND PLATFORM_OPTIONS
    -DGGML_HIP=ON
    -DAMDGPU_TARGETS=gfx1151
    -DCMAKE_HIP_ARCHITECTURES=gfx1151)
endif()

# CUDA backend, opt-in via the 'cuda-backend' feature.
# Mirrors hip-backend: builds libqvac-ggml-cuda.so as a standalone DL module
# alongside Vulkan, so the addon dlopen's whichever GPU backend it picks at
# runtime. Linux x64 and arm64 are in scope, unlike HIP which is x64-only.
# The normal arm64 build uses CUDA 13 for DGX Spark. The cuda-jetson-backend
# feature emits a separate CUDA 12 module for Jetson Orin. Windows x64 uses the
# same hybrid layout, with CUDA and Vulkan as DLL modules beside the addon.
#
# DETERMINISTIC, same reasoning as hip-backend above: requesting cuda-backend
# REQUIRES nvcc at build time. A host-dependent skip would produce a no-CUDA
# package with the SAME vcpkg ABI as a real CUDA build, which the binary cache
# then conflates. So nvcc present => CUDA; nvcc absent => hard error. With
# QVAC_CUDA_TOOLKIT set, a wrong nvcc version is a hard error too.
#
# RUNTIME fail-safe: ggml handles a failed CUDA registration itself. An absent
# or unloadable module, or a host with no NVIDIA driver, never reaches
# ggml_backend_dev_count(), so device enumeration falls through to Vulkan and
# then CPU with no addon involvement (verified on a Tesla T4, QVAC-23763).
# DETERMINISTIC, continued: the block below only runs on Linux or Windows with
# gpu-backends on, so a cuda-backend request that misses either condition would
# silently install a package with no CUDA in it and the same vcpkg ABI as a real
# CUDA build, which is the cache conflation this feature exists to avoid. Refuse
# it up front rather than one condition lower.
if(BUILD_CUDA_BACKEND AND NOT (VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_WINDOWS))
  message(FATAL_ERROR "qvac-fabric: cuda-backend supports Linux and Windows only. Got ${VCPKG_TARGET_TRIPLET}.")
endif()
if(BUILD_CUDA_BACKEND AND NOT BUILD_GPU_BACKENDS)
  message(FATAL_ERROR "qvac-fabric: cuda-backend requires the gpu-backends feature, which brings the GGML_BACKEND_DL setup the CUDA module is loaded through.")
endif()

if((VCPKG_TARGET_IS_LINUX OR VCPKG_TARGET_IS_WINDOWS) AND BUILD_GPU_BACKENDS AND BUILD_CUDA_BACKEND)
  if(VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
    message(FATAL_ERROR "qvac-fabric: cuda-backend supports Windows x64 only, got ${VCPKG_TARGET_ARCHITECTURE}.")
  endif()
  if(VCPKG_TARGET_IS_LINUX AND NOT (VCPKG_TARGET_ARCHITECTURE STREQUAL "x64" OR VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64"))
    message(FATAL_ERROR "qvac-fabric: cuda-backend supports Linux x64 and arm64 only, got ${VCPKG_TARGET_ARCHITECTURE}.")
  endif()

  set(QVAC_CUDA_JETSON ${BUILD_CUDA_JETSON_BACKEND})
  if(QVAC_CUDA_JETSON AND NOT (VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64"))
    message(FATAL_ERROR "qvac-fabric: the CUDA 12 Jetson variant is Linux arm64-only.")
  endif()

  # ggml's own CUDA CMake calls enable_language(CUDA), which fails with "No
  # CMAKE_CUDA_COMPILER could be found" whenever nvcc is off PATH. Routine
  # under vcpkg, which does not inherit an interactive shell. Locate nvcc and
  # pass it explicitly, the same way ports/ggml-speech does.
  # Order matters. An explicitly provisioned toolkit wins over whatever the host
  # happens to have at /usr/local/cuda: CI's setup-cuda assembles a pinned
  # toolkit and exports CUDACXX and CUDA_PATH, so a GPU runner or dev box
  # carrying another system toolkit must not silently shadow the pin. Searching
  # /usr/local/cuda/bin first with NO_DEFAULT_PATH did exactly that.
  #
  # QVAC-24470: vcpkg does not hash the host nvcc. Keep the expected toolkit
  # in the portfile so changing the pin changes the port hash.
  if(QVAC_CUDA_JETSON)
    set(QVAC_FABRIC_CUDA_TOOLKIT "12.6.3-jetson")
    set(QVAC_FABRIC_CUDA_VERSION_PATTERN "V12\\.6\\.85([^0-9]|$)")
  else()
    set(QVAC_FABRIC_CUDA_TOOLKIT "13.0.3-server")
    set(QVAC_FABRIC_CUDA_VERSION_PATTERN "V13\\.0\\.88([^0-9]|$)")
  endif()
  if(DEFINED ENV{CUDACXX} AND EXISTS "$ENV{CUDACXX}")
    set(NVCC_EXECUTABLE "$ENV{CUDACXX}")
  endif()
  if(NOT NVCC_EXECUTABLE AND DEFINED ENV{CUDA_PATH})
    find_program(NVCC_EXECUTABLE nvcc PATHS "$ENV{CUDA_PATH}/bin" NO_DEFAULT_PATH)
  endif()
  if(NOT NVCC_EXECUTABLE)
    find_program(NVCC_EXECUTABLE nvcc)
  endif()
  if(NOT NVCC_EXECUTABLE)
    find_program(NVCC_EXECUTABLE nvcc PATHS /usr/local/cuda/bin NO_DEFAULT_PATH)
  endif()
  if(NOT NVCC_EXECUTABLE)
    message(FATAL_ERROR "qvac-fabric: cuda-backend feature requires a CUDA toolkit. Install one providing nvcc (checked CUDACXX, CUDA_PATH/bin, PATH and /usr/local/cuda/bin). Do not request cuda-backend on a host without nvcc.")
  endif()
  execute_process(
    COMMAND "${NVCC_EXECUTABLE}" --version
    RESULT_VARIABLE QVAC_NVCC_RESULT
    OUTPUT_VARIABLE QVAC_NVCC_VERSION_OUT
    ERROR_QUIET OUTPUT_STRIP_TRAILING_WHITESPACE)
  # QVAC_CUDA_TOOLKIT names the toolkit setup-cuda provisioned, and the qvac
  # triplets hash it into this port's ABI. With it set, only the pinned
  # toolkit may build. Without it, such as a lint job on a host toolkit, the
  # build lands under a separate cache identity and only warns.
  set(QVAC_PROVISIONED_CUDA_TOOLKIT "$ENV{QVAC_CUDA_TOOLKIT}")
  if(NOT QVAC_NVCC_RESULT EQUAL 0)
    message(FATAL_ERROR "qvac-fabric: could not run ${NVCC_EXECUTABLE} --version")
  endif()
  if(QVAC_PROVISIONED_CUDA_TOOLKIT)
    if(NOT QVAC_PROVISIONED_CUDA_TOOLKIT STREQUAL QVAC_FABRIC_CUDA_TOOLKIT)
      message(FATAL_ERROR "qvac-fabric: setup-cuda provisioned ${QVAC_PROVISIONED_CUDA_TOOLKIT}, port expects ${QVAC_FABRIC_CUDA_TOOLKIT}")
    endif()
    if(NOT QVAC_NVCC_VERSION_OUT MATCHES "${QVAC_FABRIC_CUDA_VERSION_PATTERN}")
      message(FATAL_ERROR "qvac-fabric: expected ${QVAC_FABRIC_CUDA_TOOLKIT}, got: ${QVAC_NVCC_VERSION_OUT}")
    endif()
  elseif(NOT QVAC_NVCC_VERSION_OUT MATCHES "${QVAC_FABRIC_CUDA_VERSION_PATTERN}")
    message(WARNING "qvac-fabric: building with an unpinned CUDA toolkit, expected ${QVAC_FABRIC_CUDA_TOOLKIT}. Not for release builds.")
  endif()
  string(REGEX MATCH "release [0-9]+\\.[0-9]+, V[0-9.]+" QVAC_NVCC_VERSION "${QVAC_NVCC_VERSION_OUT}")
  message(STATUS "qvac-fabric: cuda-backend using nvcc at ${NVCC_EXECUTABLE} (${QVAC_NVCC_VERSION}, port expects ${QVAC_FABRIC_CUDA_TOOLKIT})")

  # x64 and the CUDA 13 arm64 module ship ggml's own default list for a CUDA 13
  # toolkit, plus 80-real. Virtual entries JIT onto newer GPUs that have no
  # cubin of their own. CUDA 13 cannot build 50, 61 or 70 at all. The fabric
  # source probes a no-op kernel on each device and skips devices that cannot
  # load the shipped code, so a module with no usable device falls through.
  #
  # The semicolons must stay backslash-escaped so vcpkg passes the architecture
  # list to CMake as one argument.
  #
  # The Jetson module is built against the L4T toolkit, which runs only on
  # Jetson Orin, so it carries only that GPU's arch.
  set(QVAC_CUDA_NO_VMM OFF)
  if(QVAC_CUDA_JETSON)
    # The fabric VMM pool falls back to cudaMalloc if Tegra cannot reserve its
    # fixed address space, so keep VMM enabled and exercise that runtime path.
    set(QVAC_CUDA_ARCHS "87-real")
  else()
    set(QVAC_CUDA_ARCHS "75-virtual\;80-virtual\;80-real\;86-real\;89-real\;90-virtual\;120a-real\;121a-real")
  endif()
  message(STATUS "qvac-fabric: cuda-backend ON, building GGML_CUDA (arch ${QVAC_CUDA_ARCHS}, nvcc ${NVCC_EXECUTABLE})")
  list(APPEND PLATFORM_OPTIONS
    -DGGML_CUDA=ON
    -DGGML_CUDA_NO_VMM=${QVAC_CUDA_NO_VMM}
    "-DCMAKE_CUDA_ARCHITECTURES=${QVAC_CUDA_ARCHS}"
    -DCMAKE_CUDA_COMPILER=${NVCC_EXECUTABLE})
  if(VCPKG_TARGET_IS_LINUX)
    list(APPEND PLATFORM_OPTIONS
    # The triplet compiles C++ with clang and -stdlib=libc++. nvcc defaults its
    # host compiler to g++, which then chokes on the clang-only -stdlib flag it
    # inherits from the link flags. Point it at clang++ so one toolchain drives
    # everything. CUDA refuses libc++ outright on x86 ("libc++ is not supported
    # on x86 system"), but that never bites: CUDA flags do not inherit
    # CMAKE_CXX_FLAGS, so the .cu compile never sees -stdlib=libc++ and only
    # the link does, where clang++ handles it.
    -DCMAKE_CUDA_HOST_COMPILER=clang++
    # -allow-unsupported-compiler: neither pinned toolkit, CUDA 13.0 or the
    # Jetson 12.6, accepts clang 22, which the monorepo standardises on
    # (.github/actions/setup-llvm). Revisit when a CUDA release accepts it.
    "-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler")
  endif()
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_KLEIDIAI)
  message(STATUS "qvac-fabric: kleidiai feature ON, building with ARM KleidiAI optimized kernels")
  # ggml only vendors KleidiAI via FetchContent; registry vcpkg-cmake sets
  # FETCHCONTENT_FULLY_DISCONNECTED=ON globally, so allow the download here.
  list(APPEND PLATFORM_OPTIONS
    -DGGML_CPU_KLEIDIAI=ON
    -DFETCHCONTENT_FULLY_DISCONNECTED=OFF
  )
endif()

if(VCPKG_TARGET_IS_ANDROID AND BUILD_OPENMP)
  message(STATUS "qvac-fabric: OpenMP for Android enabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=ON)
else()
  message(STATUS "qvac-fabric: OpenMP Disabled")
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENMP=OFF)
endif()

if (VCPKG_TARGET_IS_ANDROID AND BUILD_GPU_BACKENDS)
  list(APPEND PLATFORM_OPTIONS -DGGML_OPENCL=ON)
endif()

if(BUILD_GPU_BACKENDS AND NOT VCPKG_TARGET_IS_OSX AND NOT VCPKG_TARGET_IS_IOS)
  if(VCPKG_TARGET_IS_WINDOWS AND NOT VCPKG_TARGET_IS_MINGW)
    string(APPEND VCPKG_C_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " /I${CURRENT_INSTALLED_DIR}/include")
  else()
    string(APPEND VCPKG_C_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
    string(APPEND VCPKG_CXX_FLAGS " -isystem ${CURRENT_INSTALLED_DIR}/include")
  endif()
endif()

# Under GGML_BACKEND_DL the per-microarch backends ship as standalone
# libqvac-ggml-*.so modules that the consumer dlopen's at runtime. Built with
# -stdlib=libc++ they otherwise carry a runtime NEEDED dependency on the system
# libc++.so.1 / libc++abi.so.1, so they silently fail to dlopen on any target
# without libc++ installed, such as stock ubuntu-24.04. No CPU backend registers,
# inference aborts). Statically link the C++ runtime into the modules so they
# are self-contained, matching how the addons link themselves. The module<->addon
# boundary is the C ggml-backend ABI, so per-module libc++ copies never exchange
# C++ objects. Linux only: Apple/iOS use Metal frameworks, Android ships
# libc++_shared via the NDK STL, Windows uses the MSVC runtime.
if(VCPKG_TARGET_IS_LINUX AND DL_BACKENDS)
  string(APPEND VCPKG_LINKER_FLAGS " -static-libstdc++")
endif()

set(LLAMA_OPTIONS)
if("llama" IN_LIST FEATURES)
  list(APPEND LLAMA_OPTIONS -DLLAMA_MTMD=ON)
else()
  list(APPEND LLAMA_OPTIONS
    -DLLAMA_MTMD=OFF
    -DLLAMA_BUILD_COMMON=OFF
  )
endif()

set(BUILD_RPC_SERVER_TOOL OFF)
if(BUILD_RPC_SERVER)
  if(NOT BUILD_LLAMA)
    message(FATAL_ERROR "qvac-fabric: rpc-server feature requires the llama feature so the tools tree can be configured")
  else()
    set(BUILD_RPC_SERVER_TOOL ON)
  endif()
endif()

set(BUILD_RPC_RDMA_TRANSPORT OFF)
if(BUILD_RPC_RDMA)
  if(NOT VCPKG_TARGET_IS_LINUX)
    message(FATAL_ERROR "qvac-fabric: rpc-rdma feature is supported only on Linux because qvac-fabric RDMA uses libibverbs.")
  endif()

  message(STATUS "qvac-fabric: rpc-rdma feature ON - requiring system libibverbs")
  set(BUILD_RPC_RDMA_TRANSPORT ON)
else()
  message(STATUS "qvac-fabric: rpc-rdma feature OFF - building RPC over TCP only")
endif()

vcpkg_cmake_configure(
  SOURCE_PATH "${SOURCE_PATH}"
  DISABLE_PARALLEL_CONFIGURE
  OPTIONS
    -DGGML_NATIVE=OFF
    -DGGML_CCACHE=OFF
    -DGGML_LLAMAFILE=OFF
    -DGGML_RPC=ON
    -DGGML_RPC_RDMA=${BUILD_RPC_RDMA_TRANSPORT}
    -DLLAMA_CURL=OFF
    -DLLAMA_OPENSSL=OFF
    -DLLAMA_BUILD_TESTS=OFF
    -DLLAMA_BUILD_TOOLS=${BUILD_RPC_SERVER_TOOL}
    -DLLAMA_TOOLS_INSTALL=${BUILD_RPC_SERVER_TOOL}
    -DLLAMA_BUILD_EXAMPLES=OFF
    -DLLAMA_BUILD_SERVER=OFF
    -DLLAMA_BUILD_APP=OFF
    -DMTMD_VIDEO=OFF
    -DLLAMA_ALL_WARNINGS=OFF
    ${LLAMA_OPTIONS}
    ${PLATFORM_OPTIONS}
    ${FEATURE_OPTIONS}
)

vcpkg_cmake_install()
vcpkg_cmake_config_fixup(
  PACKAGE_NAME ggml)

if(BUILD_CUDA_BACKEND)
  if(VCPKG_TARGET_IS_WINDOWS)
    set(QVAC_CUDA_MODULE "${CURRENT_PACKAGES_DIR}/lib/qvac-ggml-cuda.dll")
  else()
    set(QVAC_CUDA_MODULE "${CURRENT_PACKAGES_DIR}/lib/libqvac-ggml-cuda.so")
  endif()
  if(NOT EXISTS "${QVAC_CUDA_MODULE}")
    message(FATAL_ERROR "qvac-fabric: expected CUDA module was not installed at ${QVAC_CUDA_MODULE}")
  endif()
endif()

if(BUILD_CUDA_BACKEND AND QVAC_CUDA_JETSON)
  # Keep both CUDA majors in one prebuild directory. The loader scans every
  # CUDA module candidate and skips the one whose runtime is unavailable.
  set(QVAC_CUDA_JETSON_MODULE "${CURRENT_PACKAGES_DIR}/lib/libqvac-ggml-cuda-jetson.so")
  file(RENAME "${QVAC_CUDA_MODULE}" "${QVAC_CUDA_JETSON_MODULE}")

  set(QVAC_GGML_TARGETS "${CURRENT_PACKAGES_DIR}/share/ggml/ggml-targets-release.cmake")
  if(NOT EXISTS "${QVAC_GGML_TARGETS}")
    message(FATAL_ERROR "qvac-fabric: expected ggml target exports were not installed at ${QVAC_GGML_TARGETS}")
  endif()
  vcpkg_replace_string(
    "${QVAC_GGML_TARGETS}"
    "libqvac-ggml-cuda.so"
    "libqvac-ggml-cuda-jetson.so")
endif()

if(BUILD_LLAMA)
  vcpkg_cmake_config_fixup(PACKAGE_NAME llama)
endif()

if(BUILD_RPC_SERVER_TOOL)
  vcpkg_copy_tools(TOOL_NAMES ggml-rpc-server AUTO_CLEAN)
endif()

vcpkg_copy_pdbs()
vcpkg_fixup_pkgconfig()


if(BUILD_LLAMA)
  file(MAKE_DIRECTORY "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/convert_hf_to_gguf.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/convert-hf-to-gguf.py")
  file(INSTALL "${SOURCE_PATH}/gguf-py" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/${PORT}")
  file(RENAME "${CURRENT_PACKAGES_DIR}/bin/vulkan_profiling_analyzer.py" "${CURRENT_PACKAGES_DIR}/tools/${PORT}/vulkan_profiling_analyzer.py")
endif()

if (NOT VCPKG_BUILD_TYPE)
  file(REMOVE "${CURRENT_PACKAGES_DIR}/debug/bin/convert_hf_to_gguf.py")
endif()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

if (VCPKG_LIBRARY_LINKAGE MATCHES "static" AND NOT (VCPKG_TARGET_IS_WINDOWS AND DL_BACKENDS))
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/bin")
  file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/bin")
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
