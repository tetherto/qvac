# Security: stb_image CVE Mitigations

## Overview

This document describes the security measures implemented to mitigate known CVEs in the stb_image library used for PNG encoding/decoding in the stable-diffusion addon.

## Known CVEs

The following CVEs affect stb_image versions prior to ~2023:

- **CVE-2021-28021**: Buffer overflow in `stbi__extend_receive` exploitable via crafted JPEG files
- **CVE-2021-37789**: Heap-based buffer overflow in `stbi__jpeg_load` causing information disclosure or DoS
- **CVE-2021-42715**: HDR loader parsing truncated RLE scanlines as infinite zero-length runs, causing DoS
- **CVE-2022-28041**: Integer overflow via `stbi__jpeg_decode_block_prog_dc` causing DoS
- **CVE-2022-28042**: Heap-based use-after-free in `stbi__jpeg_huff_decode`

## Mitigation Strategy

### 1. Library Version Update

**File:** `vcpkg.json`

Updated stb dependency to require minimum version with patches:

```json
{
  "name": "stb",
  "version>=": "2023-01-30"
}
```

This ensures vcpkg pulls a version with CVE fixes applied.

### 2. Defense-in-Depth: Input Validation

Even with patched stb_image, we implement strict input validation to prevent exploitation via malformed or malicious image data.

#### PNG Decoding (`SdModel::decodePng`)

**File:** `addon/src/model-interface/SdModel.cpp`

Protections implemented:

1. **Size Limit**: Reject input larger than 50MB to prevent memory exhaustion attacks
   - Mitigates: CVE-2021-28021, CVE-2021-37789

2. **PNG Magic Bytes Validation**: Verify PNG signature `89 50 4E 47 0D 0A 1A 0A`
   - Prevents processing of non-PNG data that could trigger vulnerabilities

3. **Dimension Validation**: Reject decoded images with dimensions > 16384px
   - Prevents integer overflow in size calculations
   - Mitigates: CVE-2022-28041

4. **Total Pixel Count Check**: Reject images exceeding 256 megapixels
   - Prevents overflow in memory allocation (width * height * channels)
   - Mitigates: CVE-2022-28041

5. **Graceful Failure**: All validation failures return empty `sd_image_t{}` with logging

#### PNG Encoding (`SdModel::encodeToPng`)

**File:** `addon/src/model-interface/SdModel.cpp`

Protections implemented:

1. **Null Pointer Check**: Validate `img.data` is not null before encoding

2. **Dimension Validation**: 
   - Reject zero or negative dimensions
   - Reject dimensions exceeding 16384px

3. **Channel Validation**: Only accept 3 (RGB) or 4 (RGBA) channels

4. **Stride Overflow Prevention**: 
   - Calculate stride as `uint64_t` to detect overflow before casting to `int`
   - Reject if stride exceeds `INT_MAX`
   - Mitigates: CVE-2022-28041

5. **Return Code Check**: Validate `stbi_write_png_to_func` return value

## Testing

**File:** `test/unit/test_stb_image_security.cpp`

Comprehensive security test suite covering:

- Empty input rejection
- Invalid magic bytes rejection
- Oversized input rejection (>50MB)
- Truncated header rejection
- Null pointer rejection
- Zero/oversized dimension rejection
- Invalid channel count rejection
- Stride overflow prevention
- Round-trip encode/decode validation

Run tests with:

```bash
npm run test:cpp:build
cd build/test/unit/
./addon-test --gtest_filter='StbImageSecurityTest.*'
```

## Attack Surface Reduction

### Input Sources

stb_image is only exposed to:

1. **img2img init_image**: User-provided PNG/JPEG bytes from JSON
   - Validated via `decodePng()` with all protections
   - Maximum 50MB input size enforced

2. **Generated output images**: Internally generated RGB data from stable-diffusion.cpp
   - Dimensions controlled by validated generation parameters
   - Data pointer guaranteed valid by successful generation

### Not User-Controllable

The following are NOT exposed to user input:

- stb_image configuration (always uses default settings)
- Image format selection (always PNG output, PNG/JPEG input)
- Compression parameters (stb_image defaults)

## Monitoring and Future Updates

### Update Process

1. **Quarterly vcpkg Updates**: Check for stb updates in vcpkg registry
2. **CVE Monitoring**: Subscribe to GitHub security advisories for nothings/stb
3. **Test After Updates**: Run full security test suite after any stb version change

### Known Limitations

- **No Formal stb Versioning**: stb uses rolling releases, making version tracking difficult
- **Upstream Security Policy**: "May take significant time for security fixes" (per SECURITY.md)
- **Mitigation**: Defense-in-depth approach ensures safety even if new CVEs emerge

## References

- [Debian DLA-4493-1](https://lists.debian.org/debian-lts-announce/2026/02/msg00032.html) - stb security update
- [nothings/stb Issue #1424](https://github.com/nothings/stb/issues/1424) - TGA buffer over-read
- [GitHub Security Lab GHSL-2023-145](https://securitylab.github.com/advisories/GHSL-2023-145_GHSL-2023-151_stb_image_h/) - Multiple memory access violations
- [stb SECURITY.md](https://github.com/nothings/stb/blob/master/SECURITY.md) - Official security policy

## Contact

For security concerns related to stb_image usage in this package, please follow the security disclosure process in the main repository's SECURITY.md file.
