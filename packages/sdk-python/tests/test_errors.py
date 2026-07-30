"""Unit tests for tetherto.qvac_sdk.errors: envelope reconstruction and the class
hierarchy. Mirrors the JS SDK's rpc-error-reconstruct.test.ts coverage."""

from __future__ import annotations

import pytest

from tetherto.qvac_sdk.errors import (
    ContextOverflowError,
    QvacError,
    RequestIdConflictError,
    RequestNotFoundError,
    RequestRejectedByPolicyError,
    RPCError,
    reconstruct_error,
)


def _envelope(**overrides):
    base = {"type": "error", "message": "boom"}
    base.update(overrides)
    return base


def test_unknown_name_falls_through_to_rpc_error():
    err = reconstruct_error(_envelope(name="SOMETHING_NEW", code=59999))
    assert isinstance(err, RPCError)
    assert isinstance(err, QvacError)
    assert err.name == "SOMETHING_NEW"
    assert err.code == 59999
    assert err.is_qvac_error
    assert str(err) == "boom"


def test_nameless_envelope_is_not_flagged_qvac():
    err = reconstruct_error(_envelope())
    assert isinstance(err, RPCError)
    assert err.name == "RPCError"
    assert err.code is None
    assert not err.is_qvac_error


def test_request_id_conflict_reconstructs_with_typed_fields():
    err = reconstruct_error(
        _envelope(name="REQUEST_ID_CONFLICT", typedFields={"requestId": "req-7"})
    )
    assert isinstance(err, RequestIdConflictError)
    assert err.request_id == "req-7"
    assert err.name == "REQUEST_ID_CONFLICT"


def test_request_not_found_reconstructs():
    err = reconstruct_error(
        _envelope(name="REQUEST_NOT_FOUND", typedFields={"requestId": "req-9"})
    )
    assert isinstance(err, RequestNotFoundError)
    assert err.request_id == "req-9"


def test_request_rejected_by_policy_reconstructs_all_fields():
    err = reconstruct_error(
        _envelope(
            name="REQUEST_REJECTED_BY_POLICY",
            typedFields={
                "requestId": "req-1",
                "kind": "completion",
                "modelId": "m-1",
                "reason": "queue full",
            },
        )
    )
    assert isinstance(err, RequestRejectedByPolicyError)
    assert (err.request_id, err.kind, err.model_id, err.reason) == (
        "req-1",
        "completion",
        "m-1",
        "queue full",
    )


def test_context_overflow_reconstructs_optional_numbers():
    err = reconstruct_error(
        _envelope(
            name="CONTEXT_OVERFLOW",
            message="prompt exceeds the model's context window",
            typedFields={"promptTokens": 4096, "ctxSize": 2048, "modelId": "m-2"},
        )
    )
    assert isinstance(err, ContextOverflowError)
    assert err.prompt_tokens == 4096
    assert err.ctx_size == 2048
    assert err.model_id == "m-2"
    assert "context window" in str(err)


def test_context_overflow_tolerates_missing_typed_fields():
    # Older workers ship no typedFields at all; reconstruction must not
    # blow up or mask the original error.
    err = reconstruct_error(_envelope(name="CONTEXT_OVERFLOW"))
    assert isinstance(err, ContextOverflowError)
    assert err.prompt_tokens is None
    assert err.ctx_size is None
    assert err.model_id is None


def test_remote_stack_and_timestamp_attach_to_reconstructed_error():
    err = reconstruct_error(
        _envelope(
            name="REQUEST_NOT_FOUND",
            typedFields={"requestId": "r"},
            stack="Error: boom\n    at worker.js:1",
            timestamp="2026-07-17T00:00:00.000Z",
        )
    )
    assert err.remote_stack is not None
    assert "worker.js" in err.remote_stack
    assert err.timestamp == "2026-07-17T00:00:00.000Z"


def test_rpc_error_carries_remote_context_too():
    err = reconstruct_error(
        _envelope(stack="trace", timestamp="2026-07-17T00:00:00.000Z")
    )
    assert err.remote_stack == "trace"
    assert err.timestamp == "2026-07-17T00:00:00.000Z"


def test_cause_is_chained_as___cause__():
    err = reconstruct_error(_envelope(name="REQUEST_NOT_FOUND", cause="disk on fire"))
    assert isinstance(err.__cause__, BaseException)
    assert "disk on fire" in str(err.__cause__)


def test_boolean_typed_field_is_not_a_number():
    # bool is an int subclass; a stray true must not become promptTokens=1.
    err = reconstruct_error(
        _envelope(name="CONTEXT_OVERFLOW", typedFields={"promptTokens": True})
    )
    assert isinstance(err, ContextOverflowError)
    assert err.prompt_tokens is None


def test_api_errors_are_qvac_errors():
    from tetherto.qvac_sdk.errors import (
        CancelFailedError,
        DeleteCacheFailedError,
        InvalidDeleteCacheParamsError,
        ModelRegistryQueryFailedError,
        ModelUnloadFailedError,
    )

    assert issubclass(CancelFailedError, QvacError)
    assert issubclass(ModelUnloadFailedError, QvacError)
    assert issubclass(ModelRegistryQueryFailedError, QvacError)
    assert issubclass(InvalidDeleteCacheParamsError, QvacError)
    assert issubclass(DeleteCacheFailedError, QvacError)

    unload = ModelUnloadFailedError("m-3")
    assert unload.model_id == "m-3"
    assert unload.code == 52400
    assert "m-3" in str(unload)


def test_flat_reexports_the_same_error_classes():
    # The flat `tetherto.qvac_sdk` surface re-exports the same class objects as
    # `tetherto.qvac_sdk.errors`; identity must hold so except-clauses catch regardless of
    # import path.
    from tetherto.qvac_sdk import CancelFailedError, ModelUnloadFailedError, errors

    assert CancelFailedError is errors.CancelFailedError
    assert ModelUnloadFailedError is errors.ModelUnloadFailedError


def test_reconstructor_names_are_known_sdk_error_codes():
    # Every RPC-boundary reconstructor keys on a wire error NAME; each must be a
    # real SDK error-code name (from the generated registry), so a rename on the
    # TS side can't leave a reconstructor keyed on a name the worker never sends.
    from tetherto.qvac_sdk._generated.error_codes import (
        CLIENT_ERROR_CODES,
        REGISTRY_ERROR_CODES,
        SERVER_ERROR_CODES,
    )
    from tetherto.qvac_sdk.errors import _RECONSTRUCTORS

    known = {**SERVER_ERROR_CODES, **CLIENT_ERROR_CODES, **REGISTRY_ERROR_CODES}
    unknown = [name for name in _RECONSTRUCTORS if name not in known]
    assert not unknown, f"reconstructors keyed on unknown error names: {unknown}"


def test_transport_json_or_raise_uses_reconstruction():
    from tetherto.qvac_sdk.bare_rpc_transport import _json_or_raise

    with pytest.raises(ContextOverflowError):
        _json_or_raise(
            b'{"type":"error","message":"prompt exceeds...","name":"CONTEXT_OVERFLOW",'
            b'"code":52421,"typedFields":{"promptTokens":100,"ctxSize":50}}'
        )
    with pytest.raises(RPCError):
        _json_or_raise(b'{"type":"error","message":"plain failure"}')
