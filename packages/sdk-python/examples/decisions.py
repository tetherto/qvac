"""Python port of packages/sdk/examples/decisions.ts.

Loads the default registry decision checkpoint, or a local GGUF path passed as
the first argument, and answers choice, urgency-score, and refund-probability
questions about a support ticket.

Python calls the generated `decide` stub, so the request is a `DecideRequest`
and the result is dumped with its camelCase wire names, like the JS output.
`Client` closes the SDK on exit, which the TypeScript example does with
`close()`.

RUN: python examples/decisions.py [path-to-decision.gguf]
"""

from __future__ import annotations

import asyncio
import json
import sys

from tetherto.qvac_sdk import (
    Client,
    DecideRequest,
    decide,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import LAYA_MULTILINGUAL_322M_Q8_0


async def main() -> int:
    model_src = sys.argv[1] if len(sys.argv) > 1 else LAYA_MULTILINGUAL_322M_Q8_0

    async with Client() as client:
        t = client.transport
        model_id = None
        try:
            print("▸ Loading decision model", file=sys.stderr)
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="llamacpp-decision",
                model_config={"device": "cpu"},
            )
            request = DecideRequest.model_validate(
                {
                    "type": "decide",
                    "modelId": model_id,
                    "state": (
                        "My payment failed twice and I was charged both times. "
                        "Please refund the duplicate."
                    ),
                    "questions": {
                        "department": {
                            "type": "choice",
                            "instructions": "Which team should handle this ticket?",
                            "criteria": ["billing", "technical"],
                        },
                        "urgency": {
                            "type": "score",
                            "instructions": "How urgent is this?",
                            "criteria": [
                                "not urgent",
                                "somewhat urgent",
                                "very urgent",
                            ],
                        },
                        "refund": {
                            "type": "noul",
                            "instructions": "The customer asks for a refund.",
                        },
                    },
                }
            )
            response = await decide(t, request)
            result = response.result.model_dump(
                mode="json", by_alias=True, exclude_none=True
            )
            print(json.dumps(result, indent=2))
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                await unload_model(t, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
