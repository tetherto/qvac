"""Tests for plugin-aware generation: `generate.py --plugin` turns a custom
plugin's exported contract (fixtures/echo_plugin_contract.json, produced by
the SDK's export-plugin-contract script from the e2e echo-plugin fixture)
into a typed module whose functions round-trip pluginInvoke(_stream)."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "echo_plugin_contract.json"

spec = importlib.util.spec_from_file_location(
    "generate_for_plugins", PACKAGE_ROOT / "scripts" / "generate.py"
)
assert spec is not None and spec.loader is not None
generate = importlib.util.module_from_spec(spec)
sys.modules["generate_for_plugins"] = generate
spec.loader.exec_module(generate)


def _generate_echo_module():
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp) / "plugins"
        generate.generate_plugins(
            ["--plugin", str(FIXTURE), "--plugins-out", str(out_dir)]
        )
        module_path = out_dir / "echo.py"
        assert module_path.exists()
        module_spec = importlib.util.spec_from_file_location(
            "echo_plugin_client", module_path
        )
        assert module_spec is not None and module_spec.loader is not None
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module


class FakeTransport:
    def __init__(self, response=None, stream_items=None):
        self.response = response
        self.stream_items = stream_items or []
        self.sent: Any = None

    async def call(self, payload):
        self.sent = payload
        return self.response

    async def call_stream(self, payload):
        self.sent = payload
        for item in self.stream_items:
            yield item

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


async def test_generated_plugin_module_round_trips_both_call_shapes():
    module = _generate_echo_module()
    assert module.MODEL_TYPE == "echo"
    assert set(module.__all__) == {"echo", "echo_stream"}

    transport = FakeTransport(
        response={"type": "pluginInvoke", "result": {"message": "hi back"}}
    )
    response = await module.echo(transport, "m-1", module.EchoRequest(message="hi"))
    assert isinstance(response, module.EchoResponse)
    assert response.message == "hi back"
    assert transport.sent == {
        "type": "pluginInvoke",
        "modelId": "m-1",
        "handler": "echo",
        "params": {"message": "hi"},
    }

    stream_transport = FakeTransport(
        stream_items=[
            {"type": "pluginInvokeStream", "result": {"chunk": "hello"}, "done": False},
            {"type": "pluginInvokeStream", "result": {"chunk": "world"}, "done": False},
            {"type": "pluginInvokeStream", "result": None, "done": True},
        ]
    )
    chunks = [
        chunk.chunk
        async for chunk in module.echo_stream(
            stream_transport, "m-1", module.EchoStreamRequest(message="hello world")
        )
    ]
    assert chunks == ["hello", "world"]
    assert stream_transport.sent["handler"] == "echoStream"


async def test_generated_models_validate_wire_shapes():
    module = _generate_echo_module()
    # extra="forbid" carried through from the plugin's zod .strict() output
    # shape, and required fields enforced.
    import pydantic
    import pytest

    with pytest.raises(pydantic.ValidationError):
        module.EchoResponse.model_validate({"message": "x", "extra": True})
    with pytest.raises(pydantic.ValidationError):
        module.EchoRequest.model_validate({})
