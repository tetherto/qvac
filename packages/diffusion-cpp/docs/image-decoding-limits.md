# Image decoding limits

The diffusion addon's `image_codec::decodeImage` accepts PNG and JPEG input for img2img, video guidance, ESRGAN upscaling, and ABot-World scene creation. It returns an empty `sd_image_t` for invalid or over-limit input with a failure reason; callers report an `InvalidArgument` error.

Before full decode, the wrapper checks the format signature, rejects compressed input above 50 MiB, reads dimensions with `stbi_info_from_memory`, and rejects images above the configured per-image pixel limit (64 Mi pixels by default). PNG compressed data must inflate to at least the size declared by its header and no more than 64 KiB beyond it. JPEG padding before the frame header is accepted; progressive JPEGs are limited to 32 scans. The source-data budget is 64 MiB for 16-bit PNG and 128 MiB for four-component JPEG. This reduces peak memory for 16-bit grayscale input, but is not a strict bound on decoder peak memory. The decoder requests three RGB channels and confirms the dimensions returned by the full decode match the inspected header. Multi-reference img2img and video jobs retain at most the configured decoded input job budget (128 Mi pixels by default) across their input images. Single-image img2img, ESRGAN, and ABot-World use the per-image limit. The limits apply to the native entry points as well as the JavaScript API. ESRGAN also checks projected output before generation and each upscale pass against the configured per-image limit.

`config.max_image_pixels` and `config.max_job_pixels` are positive integer pixel counts for image and video models. Standalone ESRGAN accepts `max_image_pixels`; ABot-World uses `maxImagePixels`. The defaults are 67,108,864 and 134,217,728 pixels respectively. An explicit override can raise or lower either limit. Increasing a limit can substantially increase CPU/GPU memory use; choose values for the target device and model. The independent 16,384-pixel edge bound, 50 MiB compressed-input bound, source-data budgets, PNG inflate check, and JPEG scan bound remain in force. The maximum configurable per-image value is 268,435,456 pixels (16,384 squared). The job value must fit in a signed 32-bit integer.

The decoder compiles only PNG and JPEG loaders; HDR, TGA, PSD, PIC, PNM, GIF, and BMP are disabled. `STBI_MAX_DIMENSIONS` is set to 16384 as an additional bound within stb. Decoded buffers use `image_codec::FreeDeleter` so exceptions release them.

`encodeToPng` and `encodeToJpeg` separately reject null data, invalid dimensions or channels, and unsupported values for their encoder APIs. Encoding is not subject to the input byte or pixel limits above.

The C++ regression tests in `test/unit/test_image_decoding_limits.cpp` cover PNG and JPEG decoding, unsupported formats, compressed size, inflated PNG size, JPEG scans, pixel and remaining-job budgets, and encoding validation. Run them with `npm run test:cpp`.

Report suspected vulnerabilities through the repository's `SECURITY.md` disclosure process.
