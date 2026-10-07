cmake_minimum_required(VERSION 3.22.1)
project(qvac_kotlin_runtime LANGUAGES CXX)

add_library(qvac-kotlin-runtime SHARED runtime.cpp)
target_compile_features(qvac-kotlin-runtime PRIVATE cxx_std_17)
