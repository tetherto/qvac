# Testing on Android with Termux

It is possible to test on Android using Termux instead of building a native application. That might speed-up testing but Termux environment is a Linux environment rather than a typical Android environment with Android system libraries (including the standard library). Therefore, you might have success generating with the following command instead and following the steps from Zbigniew.

```
bare-make generate \
  --platform android \
  --arch arm64 \
  -D CMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -D ANDROID_STL=c++_shared \
  -D CMAKE_SHARED_LINKER_FLAGS="-static-libgcc -static-libstdc++" \
  -D CMAKE_EXE_LINKER_FLAGS="-static-libgcc -static-libstdc++"
```

Then, try to patchelf target binary (for android). Examples:
```
patchelf --replace-needed libstdc++.so.6 libc++.so.1 --set-rpath '$PREFIX/lib' tetherto__qvac-lib-infer-llamacpp-embed.bare
patchelf --replace-needed libc++.so.1 libc++_shared.so --set-rpath '$PREFIX/lib' tetherto__qvac-lib-infer-llamacpp-embed.bare
patchelf --replace-needed libm.so.6 libc.so --set-rpath '/system/lib64:$PREFIX/lib' tetherto__qvac-lib-infer-llamacpp-embed.bare
```

## Error: dlopen failed: library "libvulkan.so.1" not found
```
create new bert interface
ggml_vulkan: Error: Vulkan 1.2 required.
/home/zbig9000/.local/share/vcpkg/buildtrees/llama-cpp/src/7197b96277-7f5b65adcd.clean/ggml/src/ggml-vulkan/ggml-vulkan.cpp:3592: fatal error
0: 0x76ffadd37c 
1: 0x76ffadd288 ggml_print_backtrace
2: 0x76ffadd4e4 ggml_abort
3: 0x76ffa44b44 
4: 0x76ffa4b03c ggml_backend_vk_reg
5: 0x76ff9ec6d0 _ZN21ggml_backend_registryC2Ev
6: 0x76ff9ea324 ggml_backend_reg_by_name
7: 0x76ff91c494 llama_supports_rpc
8: 0x76ff83014c _Z25common_params_parser_initR13common_params13llama_examplePFviPPcE
9: 0x76ff8222d8 _Z19common_params_parseiPPcR13common_params13llama_examplePFviS0_E
10: 0x76ff81aaac _ZN9BertModelC1ERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_
11: 0x76ff813304 _ZN28qvac_lib_inference_addon_cpp5AddonI9BertModelEC2IJP8js_env_sNSt6__ndk117reference_wrapperIKNS6_12basic_stringIcNS6_11char_traitsIcEENS6_9allocatorIcEEEEEESF_P10js_value_sSH_SH_EEEDpT_
12: 0x76ff81656c _ZN28qvac_lib_inference_addon_cpp11JsInterfaceINS_5AddonI9BertModelEEE14createInstanceEP8js_env_sP18js_callback_info_s
13: 0x77b57e5ac0 _ZN13js_callback_s7on_callERKN2v820FunctionCallbackInfoINS0_5ValueEEE
```

Can be resolved with:
```
pkg update
pkg install vulkan-loader vulkan-tools
export LD_LIBRARY_PATH="$PREFIX/lib:$LD_LIBRARY_PATH"
```


## Working with android device from local machine terminal:

Updates
```
pkg update
pkg install PACKAGE
```

Send file to android device termux (or scp):
```
adb push prebuilds/android-arm64/tetherto__qvac-lib-infer-llamacpp-embed.bare /storage/emulated/0/Download/
```

Get file to android device termux (or scp):
```
adb pull /storage/emulated/0/Download/libvulkan.txt .
```

Run/stop ssh:
```
sshd
pkill sshd
```

From local machine run (via usb cable connection):
```
adb forward tcp:8022 tcp:8022
ssh -p 8022 u0_aXXX@127.0.0.1 -i ~/.ssh/PRIVATE_KEY
```

## Working with Android device: tips

Enable Android Developer Mode, also known as Developer options, is a hidden menu in Android settings designed for developers to test and debug apps. It provides access to various advanced settings and features that are not typically available to regular users. To enable it, navigate to your device's Settings, find the Build number (usually under About Phone or Software information), and tap it repeatedly (usually seven times). A message will appear indicating you've enabled developer options.

Enable USB debugging on an Android device, you generally need to access the Developer options menu within your device's settings and then enable the "USB debugging" option. This process usually involves navigating to "About phone" (or similar), tapping the "Build number" multiple times, and then finding and enabling the USB debugging toggle in the "Developer options" menu. 
=======
