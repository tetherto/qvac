# samples

Sample test images for the `@qvac/ocr-ggml` addon. This directory holds raw
fixture data (JPEG / PNG / BMP); the JS code examples that consume them live
in [`examples/`](../examples/).

## Default fixture

The CLI (`ocr-ggml-cli`) and the examples (`examples/quickstart.js`,
`examples/doctr.js`, `examples/backend-device.js`) look for
`samples/english.png` by default. It is the WHO poster used by upstream
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml/tree/main/examples)
and is **tracked in this repository**, so in a monorepo checkout the
defaults just work:

```bash
bare ocr-ggml-cli \
    --detector /path/to/craft_mlt_25k.gguf \
    --recognizer /path/to/english_g2.gguf
```

Note that `samples/` is **not published to npm** (it is not in the
package.json `files` whitelist) — consumers of the published package
should pass their own image.

Override the fixture path any time with `--image PATH` or the
`OCR_GGML_IMAGE` environment variable.
