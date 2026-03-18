cmake_minimum_required(VERSION 3.25)

project(parakeet-addon-interface LANGUAGES CXX C)
set(CMAKE_CXX_STANDARD 20)

# Build parakeet core lib
set(LIB_NAME parakeet_model_core)
set(LIB_SRCS_PATH ${PROJECT_SOURCE_DIR}/src/model-interface)

set(LIB_SRCS
        ${LIB_SRCS_PATH}/ParakeetTypes.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetModel.cpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetConfig.cpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetHandlers.hpp
        ${LIB_SRCS_PATH}/parakeet/ParakeetHandlers.cpp
        ${PROJECT_SOURCE_DIR}/src/js-interface/JSAdapter.hpp
        ${PROJECT_SOURCE_DIR}/src/js-interface/JSAdapter.cpp
)

add_library(${LIB_NAME} STATIC ${LIB_SRCS})

target_include_directories(${LIB_NAME} PRIVATE
        ${PROJECT_SOURCE_DIR}/src
        ${CMAKE_BINARY_DIR}
        ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
)

# Link ONNX Runtime
find_package(onnxruntime CONFIG REQUIRED)
target_link_libraries(${LIB_NAME} PRIVATE
        onnxruntime::onnxruntime
)

# Include path for addon src
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/src)

