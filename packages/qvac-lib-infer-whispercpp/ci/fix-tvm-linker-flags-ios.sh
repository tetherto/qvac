#!/bin/bash

set -e

cd $GITHUB_WORKSPACE/addon/mlc-llm/3rdparty/tvm

line_number=$(awk '/set\(HIDE_SYMBOLS_LINKER_FLAGS "-Wl,--exclude-libs,ALL"\)/{print NR}' $GITHUB_WORKSPACE/addon/mlc-llm/3rdparty/tvm/CMakeLists.txt)

sed -i '' "${line_number}s/.*/set(HIDE_SYMBOLS_LINKER_FLAGS "-Wl")/" $GITHUB_WORKSPACE/addon/mlc-llm/3rdparty/tvm/CMakeLists.txt

