"""Python port of packages/sdk/examples/translation/translation-llm.ts.

LLM-backed translation with an explicit source language and with source
auto-detection. `translate()` returns a run whose `text` is an awaitable full
string (non-stream mode); with `from_` omitted for an LLM model, the source
language is detected from the input (needs the `langdetect` extra).

RUN: python examples/translation.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, load_model, translate, unload_model
from tetherto.qvac_sdk.models import SALAMANDRATA_2B_INST_Q4


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t, model_src=SALAMANDRATA_2B_INST_Q4, on_progress=print_progress
            )

            # Explicit source language.
            eng_text = "Hello, how are you today?"
            explicit = translate(
                t,
                model_id=model_id,
                text=eng_text,
                from_="en",
                to="it",
                model_type="llamacpp-completion",
                stream=False,
            )
            translated_explicit = await explicit.text

            # Auto-detected source (await the previous translate first — the LLM
            # addon runs one job at a time).
            esp_text = "Hola, como estas?"
            autodetect = translate(
                t,
                model_id=model_id,
                text=esp_text,
                to="en",
                model_type="llamacpp-completion",
                stream=False,
            )
            translated_autodetect = await autodetect.text

            print(f'Explicit source: {eng_text} -> "{translated_explicit}"')
            print(f'Autodetected source: {esp_text} -> "{translated_autodetect}"')

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
