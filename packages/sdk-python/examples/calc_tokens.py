"""Count raw and chat-templated prompt tokens without running generation.

RUN: python examples/calc_tokens.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    CalcTokensRequest,
    Client,
    calc_tokens,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4


async def main() -> int:
    async with Client() as client:
        transport = client.transport
        model_id = None
        try:
            model_id = await load_model(transport, model_src=QWEN3_600M_INST_Q4)
            raw = await calc_tokens(
                transport,
                CalcTokensRequest.model_validate(
                    {"modelId": model_id, "text": "Summarize this conversation."}
                ),
            )
            rendered = await calc_tokens(
                transport,
                CalcTokensRequest.model_validate(
                    {
                        "modelId": model_id,
                        "history": [
                            {
                                "role": "system",
                                "content": "You are a helpful assistant.",
                            }
                        ],
                        "text": "Summarize this conversation.",
                    }
                ),
            )
            print({"raw": raw.tokens, "rendered": rendered.tokens})
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                await unload_model(transport, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
