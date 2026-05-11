cmake_minimum_required(VERSION 3.25)

project(whisper-addon-interface LANGUAGES CXX C)
set(CMAKE_CXX_STANDARD 20)

# Build whisper core lib
set(LIB_NAME whisper_model_core)
set(LIB_SRCS_PATH ${PROJECT_SOURCE_DIR}/src/model-interface)

set(LIB_SRCS
        ${LIB_SRCS_PATH}/WhisperTypes.hpp
        ${LIB_SRCS_PATH}/whisper.cpp/WhisperCppModel.hpp
        ${LIB_SRCS_PATH}/whisper.cpp/WhisperCppModel.cpp
        ${LIB_SRCS_PATH}/whisper.cpp/WhisperConfig.hpp
        ${LIB_SRCS_PATH}/whisper.cpp/WhisperConfig.cpp
        ${PROJECT_SOURCE_DIR}/src/addon/WhisperModelJobsHandler.hpp
        ${PROJECT_SOURCE_DIR}/src/addon/WhisperModelJobsHandler.cpp
        ${PROJECT_SOURCE_DIR}/src/js-interface/JSAdapter.hpp
        ${PROJECT_SOURCE_DIR}/src/js-interface/JSAdapter.cpp
        ${PROJECT_SOURCE_DIR}/src/model-interface/WhisperParameterMappings.hpp
        ${PROJECT_SOURCE_DIR}/src/model-interface/WhisperParameterMappings.cpp
)

add_library(${LIB_NAME} STATIC ${LIB_SRCS})

target_include_directories(${LIB_NAME} PRIVATE
        ${PROJECT_SOURCE_DIR}/whisper.cpp/include
        ${CMAKE_BINARY_DIR}
        ${CMAKE_BINARY_DIR}/_bare/node_modules/bare-headers/include
)

# Platform-specific libraries
if(APPLE)
    set(PLATFORM_LIBS ggml-metal)
else()
    set(PLATFORM_LIBS "")
endif()

# BLAS library (optional)
find_library(BLAS_LIBRARY NAMES blas openblas)
if(BLAS_LIBRARY)
    set(BLAS_LIBS ${BLAS_LIBRARY})
else()
    set(BLAS_LIBS "")
endif()

target_link_libraries(${LIB_NAME} PRIVATE
        whisper
        ggml
        ggml-cpu
        ${BLAS_LIBS}
        ${PLATFORM_LIBS}
        ggml-base
  "$<LINK_LIBRARY:WHOLE_ARCHIVE>"
)

# embed mel_filters.bin
function(add_target_resource target input)
    cmake_path(GET input PARENT_PATH input_parent_path)
    cmake_path(GET input FILENAME input_filename)
    string(MAKE_C_IDENTIFIER ${input_filename} input_identifier)
    file(WRITE ${CMAKE_BINARY_DIR}/${input_identifier}.hpp
            "#pragma once\n\n"
            "#include <cstddef>\n"
            "extern const unsigned char ${input_identifier}[];\n"
            "extern const size_t ${input_identifier}_size;\n"
    )
    file(READ ${input} filedata HEX)
    string(REPEAT "[0-9a-f]" 32 column_pattern)
    string(REGEX REPLACE "(${column_pattern})" "\\1\n" content "${filedata}")
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1, " content "${content}")
    string(REGEX REPLACE ", $" "" content "${content}")
    file(WRITE ${CMAKE_BINARY_DIR}/${input_identifier}.cpp
            "#include \"${input_identifier}.hpp\"\n\n"
            "const unsigned char ${input_identifier}[]{ ${content} };\n"
            "const size_t ${input_identifier}_size { sizeof(${input_identifier}) };\n"
    )
    target_sources(${target} PRIVATE ${CMAKE_BINARY_DIR}/${input_identifier}.cpp)
endfunction()

# Resource file list
add_target_resource(${LIB_NAME} "${CMAKE_SOURCE_DIR}/addon/src/model-interface/binaries/mel_filters.bin")

# Agrega el include path de whisper.cpp/include
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp/include)
