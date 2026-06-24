# samples

Sample test images for the `@qvac/ocr-ggml` addon. This directory holds raw
fixture data (JPEG / PNG / BMP); the JS code examples that consume them live
in [`examples/`](../examples/).

## Default fixture

The CLI (`ocr-ggml-cli`) and the quickstart example (`examples/quickstart.js`)
look for `samples/english.png` by default. The canonical version is the WHO
poster used by upstream
[`tetherto/easy-ocr-ggml`](https://github.com/tetherto/easy-ocr-ggml/tree/main/examples)
— a copy can be obtained from there until we ship it with the package.

```bash
# Once you have english.png locally:
cp /path/to/english.png samples/english.png

# Then the defaults just work:
bare ocr-ggml-cli \
    --detector /path/to/craft_mlt_25k.gguf \
    --recognizer /path/to/english_g2.gguf
```

Override the fixture path any time with `--image PATH` or the
`OCR_GGML_IMAGE` environment variable.
