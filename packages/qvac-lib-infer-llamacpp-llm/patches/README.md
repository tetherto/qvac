The following patch allows to solve issues in `bare-make` when compiling to Android by adressing de issues below.

## Android System Version
VCPKG documentation explains that `VCPKG_CMAKE_SYSTEM_VERSION` can be set to choose Android system version. It is counter-intutive that, even if this value is adjusted at the project `CMakeLists.txt` or passed as a `-D` the value is not respected an overriden to target version 21. The patch sets it to version 24 that is needed to compile `llama.cpp`

## NDK Path
VCPKG expects not only `ANDROID_HOME` but also `ANDROID_NDK_HOME` to be set. This should be a resposability of `cmake-vcpkg` to ensure all variables are properly set or at-least show an straightforward message if its missing. The NDK path can be automatically derived from existing `ANDROID_HOME`
