# Browser build: the same engine sources as the Bare addon, compiled with
# Emscripten against a statically linked Fabric with the WebGPU backend.
# Driven by scripts/build-web.mjs, which fetches and verifies the sources
# pinned in source-lock.json.
cmake_minimum_required(VERSION 3.25)
project(llm-llamacpp-web LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with the pinned Emscripten toolchain (emcmake)")
endif()
foreach(dir FABRIC_SOURCE_DIR EMDAWNWEBGPU_DIR PICOJSON_DIR CONCURRENTQUEUE_DIR INFERENCE_ADDON_CPP_DIR OUTPUT_DIR)
  if(NOT DEFINED ${dir} OR NOT EXISTS "${${dir}}")
    message(FATAL_ERROR "${dir} must point to an existing directory")
  endif()
endforeach()

foreach(option
    BUILD_SHARED_LIBS GGML_BACKEND_DL GGML_WEBGPU_JSPI GGML_NATIVE GGML_OPENMP
    GGML_METAL GGML_VULKAN GGML_CUDA GGML_HIP GGML_OPENCL GGML_BLAS GGML_RPC
    GGML_LLAMAFILE LLAMA_BUILD_TESTS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_TOOLS
    LLAMA_BUILD_SERVER LLAMA_BUILD_APP LLAMA_BUILD_HTML LLAMA_BUILD_MTMD
    LLAMA_OPENSSL LLAMA_SUBPROCESS LLAMA_WASM_MEM64)
  set(${option} OFF CACHE BOOL "" FORCE)
endforeach()
set(GGML_WEBGPU ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_MTMD ON CACHE BOOL "" FORCE)

add_compile_options(-sMEMORY64=0 "$<$<COMPILE_LANGUAGE:CXX>:-fexceptions>")
add_link_options(-sMEMORY64=0 -fexceptions)
add_subdirectory("${FABRIC_SOURCE_DIR}" fabric EXCLUDE_FROM_ALL)

set(ADDON_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
include("${ADDON_ROOT}/cmake/engine-sources.cmake")

# The engine includes mtmd as <llama/mtmd/...>, the layout @qvac/fabric ships.
set(FABRIC_INCLUDE_LAYOUT "${CMAKE_CURRENT_BINARY_DIR}/fabric-include")
file(MAKE_DIRECTORY "${FABRIC_INCLUDE_LAYOUT}/llama")
file(CREATE_LINK "${FABRIC_SOURCE_DIR}/tools/mtmd"
  "${FABRIC_INCLUDE_LAYOUT}/llama/mtmd" SYMBOLIC)

add_executable(llm-llamacpp
  "${ADDON_ROOT}/addon/src/js-interface/web/binding.cpp"
  ${LLM_ENGINE_SOURCES})
target_compile_features(llm-llamacpp PRIVATE cxx_std_20)
target_include_directories(llm-llamacpp PRIVATE
  "${ADDON_ROOT}/addon/src"
  "${ADDON_ROOT}/../fabric/include"
  "${INFERENCE_ADDON_CPP_DIR}"
  "${PICOJSON_DIR}/.."
  "${CONCURRENTQUEUE_DIR}/.."
  "${FABRIC_INCLUDE_LAYOUT}"
  "${FABRIC_SOURCE_DIR}"
  "${FABRIC_SOURCE_DIR}/vendor")
target_link_libraries(llm-llamacpp PRIVATE llama-common llama mtmd)
set_target_properties(llm-llamacpp PROPERTIES
  SUFFIX ".mjs"
  RUNTIME_OUTPUT_DIRECTORY "${OUTPUT_DIR}")
target_link_options(llm-llamacpp PRIVATE
  --no-entry
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createLlmLlamacpp
  -sENVIRONMENT=worker
  -sEXIT_RUNTIME=0
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=8388608
  -sMAXIMUM_MEMORY=4294967296
  -lworkerfs.js
  "-sEXPORTED_FUNCTIONS=_qvac_web_create,_qvac_web_activate,_qvac_web_run,_qvac_web_save_cache,_qvac_web_discard_cache,_qvac_web_destroy,_qvac_web_result"
  "-sEXPORTED_RUNTIME_METHODS=ccall,FS"
  -sASYNCIFY=1
  -sASYNCIFY_STACK_SIZE=1048576)
