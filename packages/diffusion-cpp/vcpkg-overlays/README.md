# Diffusion engine overlays

These package-local ports consume the Windows size optimizations proposed for
the engines' `2026-08-11` branches:

- [stable-diffusion.cpp #56](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp/pull/56)
  at `683ac894cbc6b4d6d448ec3c363fba137e97d83d`.
- [ggml #120](https://github.com/tetherto/qvac-ext-ggml/pull/120)
  at `75b340f542ea0e992a8acfa9da430dfda57b5fba`.

The ports are copied from the registry versions already selected by this package
(`stable-diffusion-cpp` 2026-08-11#5 and `ggml` 2026-08-11#1). They change the
source pins/checksums and enable `SD_LTO` / `GGML_LTO` on Windows. Function and
data section options come from the engine CMake files; Bare exports and final
addon linker settings remain in this package's CMake file.

Keep the ggml source pin and checksum identical in both ports, including the
copy fetched for stable-diffusion's internal headers. Other platform options,
GPU features, and installed library layout follow the registry ports.

Once the registry publishes these engine changes, update this package's registry
baseline and minimum port versions, then remove these overlays and their
`overlay-ports` entry from `vcpkg-configuration.json`.
