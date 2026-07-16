"""Typed error hierarchy + RPC error reconstruction.

Mirrors the JS SDK's `client/rpc/rpc-error.ts` and the `QvacErrorBase`
subclasses in `utils/errors-server.ts`. Worker errors arrive in-band as a
JSON envelope:

    {"type": "error", "message": ..., "name"?: ..., "code"?: ...,
     "cause"?: ..., "stack"?: ..., "timestamp"?: ..., "typedFields"?: {...}}

`reconstruct_error()` rebuilds the original typed class for the handful that
carry `typedFields` and have a reconstructor, so `isinstance(err,
ContextOverflowError)` holds across the RPC boundary. Every other worker
error becomes a generic `RPCError` that still carries `name`/`code` so
consumers can branch on the error code without a dedicated class.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# Error codes mirror packages/sdk/schemas/sdk-errors-server.ts. Only the
# codes referenced from Python live here; the SDK's own file is the source
# of truth for the full range.
_CODE_CANCEL_FAILED = 52408
_CODE_MODEL_UNLOAD_FAILED = 52400
_CODE_REQUEST_ID_CONFLICT = 52417
_CODE_REQUEST_NOT_FOUND = 52418
_CODE_REQUEST_REJECTED_BY_POLICY = 52420
_CODE_CONTEXT_OVERFLOW = 52421
_CODE_DELETE_CACHE_FAILED = 53200
_CODE_INVALID_DELETE_CACHE_PARAMS = 53201
_CODE_MODEL_REGISTRY_QUERY_FAILED = 53950


class QvacError(Exception):
    """Base of every SDK error, whether raised client-side or reconstructed
    from an RPC error envelope.

    Carries the structured fields the JS `QvacErrorBase` serialises: a stable
    SCREAMING_SNAKE_CASE `name`, a numeric `code`, the human `message`, and
    the optional cross-RPC context (`timestamp`, `remote_stack`). A `cause`
    is chained through Python's `__cause__` so tracebacks read naturally.
    """

    name: str
    code: int | None
    timestamp: str | None
    remote_stack: str | None

    def __init__(
        self,
        message: str,
        *,
        name: str | None = None,
        code: int | None = None,
        cause: Any = None,
        timestamp: str | None = None,
        remote_stack: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.name = name if name is not None else type(self).__name__
        self.code = code
        self.timestamp = timestamp
        self.remote_stack = remote_stack
        if cause is not None:
            self.__cause__ = (
                cause if isinstance(cause, BaseException) else RuntimeError(str(cause))
            )


class RPCError(QvacError):
    """Fallback wrapper for a worker error with no typed reconstructor.

    `is_qvac_error` mirrors the JS flag: true when the envelope carried both
    a `name` and a `code` (i.e. it originated from a `QvacErrorBase`), so
    code-based predicates keep working even without the concrete class.
    """

    is_qvac_error: bool

    def __init__(self, response: dict[str, Any]) -> None:
        name = response.get("name")
        code = response.get("code")
        self.is_qvac_error = bool(name and code)
        super().__init__(
            str(response.get("message", "")),
            name=name if isinstance(name, str) else "RPCError",
            code=code if isinstance(code, int) else None,
            cause=response.get("cause"),
            timestamp=_opt_str(response, "timestamp"),
            remote_stack=_opt_str(response, "stack"),
        )


# ---- Cross-RPC typed errors (reconstructed by name) ---------------------


class RequestIdConflictError(QvacError):
    def __init__(
        self, request_id: str, *, cause: Any = None, message: str | None = None
    ) -> None:
        self.request_id = request_id
        super().__init__(
            message or f"Request ID conflict: {request_id}",
            name="REQUEST_ID_CONFLICT",
            code=_CODE_REQUEST_ID_CONFLICT,
            cause=cause,
        )


class RequestNotFoundError(QvacError):
    def __init__(
        self, request_id: str, *, cause: Any = None, message: str | None = None
    ) -> None:
        self.request_id = request_id
        super().__init__(
            message or f"Request not found: {request_id}",
            name="REQUEST_NOT_FOUND",
            code=_CODE_REQUEST_NOT_FOUND,
            cause=cause,
        )


class RequestRejectedByPolicyError(QvacError):
    def __init__(
        self,
        request_id: str,
        kind: str,
        model_id: str,
        reason: str,
        *,
        cause: Any = None,
        message: str | None = None,
    ) -> None:
        self.request_id = request_id
        self.kind = kind
        self.model_id = model_id
        self.reason = reason
        super().__init__(
            message or reason or "Request rejected by policy",
            name="REQUEST_REJECTED_BY_POLICY",
            code=_CODE_REQUEST_REJECTED_BY_POLICY,
            cause=cause,
        )


class ContextOverflowError(QvacError):
    """Prompt exceeded the loaded model's context window. Distinct from a
    generic failure so callers can drive UX (truncate, raise `n_ctx`, start a
    new thread). The token/ctx fields are present only when the worker's
    error message carried them."""

    def __init__(
        self,
        prompt_tokens: int | None = None,
        ctx_size: int | None = None,
        model_id: str | None = None,
        *,
        cause: Any = None,
        message: str | None = None,
    ) -> None:
        self.prompt_tokens = prompt_tokens
        self.ctx_size = ctx_size
        self.model_id = model_id
        super().__init__(
            message or "prompt exceeds the model's context window",
            name="CONTEXT_OVERFLOW",
            code=_CODE_CONTEXT_OVERFLOW,
            cause=cause,
        )


# ---- Client-raised errors (from api.py wrappers) ------------------------


class CancelFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "cancel failed",
            name="CANCEL_FAILED",
            code=_CODE_CANCEL_FAILED,
            cause=cause,
        )


class ModelUnloadFailedError(QvacError):
    def __init__(self, model_id: str, *, cause: Any = None) -> None:
        self.model_id = model_id
        super().__init__(
            f"failed to unload model {model_id!r}",
            name="MODEL_UNLOAD_FAILED",
            code=_CODE_MODEL_UNLOAD_FAILED,
            cause=cause,
        )


class ModelRegistryQueryFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "model registry query failed",
            name="QVAC_MODEL_REGISTRY_QUERY_FAILED",
            code=_CODE_MODEL_REGISTRY_QUERY_FAILED,
            cause=cause,
        )


class InvalidDeleteCacheParamsError(QvacError):
    def __init__(self, *, cause: Any = None) -> None:
        super().__init__(
            "deleteCache needs either all=True or kv_cache_key",
            name="INVALID_DELETE_CACHE_PARAMS",
            code=_CODE_INVALID_DELETE_CACHE_PARAMS,
            cause=cause,
        )


class DeleteCacheFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "delete cache failed",
            name="DELETE_CACHE_FAILED",
            code=_CODE_DELETE_CACHE_FAILED,
            cause=cause,
        )


# ---- Reconstruction ------------------------------------------------------


def _typed_fields(response: dict[str, Any]) -> dict[str, Any]:
    fields = response.get("typedFields")
    return fields if isinstance(fields, dict) else {}


def _str_field(fields: dict[str, Any], key: str, fallback: str = "") -> str:
    value = fields.get(key)
    return value if isinstance(value, str) else fallback


def _opt_num_field(fields: dict[str, Any], key: str) -> int | None:
    value = fields.get(key)
    return (
        int(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else None
    )


def _opt_str_field(fields: dict[str, Any], key: str) -> str | None:
    value = fields.get(key)
    return value if isinstance(value, str) and value else None


def _opt_str(response: dict[str, Any], key: str) -> str | None:
    value = response.get(key)
    return value if isinstance(value, str) and value else None


def _reconstruct_request_id_conflict(response: dict[str, Any]) -> QvacError:
    return RequestIdConflictError(
        _str_field(_typed_fields(response), "requestId"),
        cause=response.get("cause"),
        message=_opt_str(response, "message"),
    )


def _reconstruct_request_not_found(response: dict[str, Any]) -> QvacError:
    return RequestNotFoundError(
        _str_field(_typed_fields(response), "requestId"),
        cause=response.get("cause"),
        message=_opt_str(response, "message"),
    )


def _reconstruct_request_rejected(response: dict[str, Any]) -> QvacError:
    fields = _typed_fields(response)
    return RequestRejectedByPolicyError(
        _str_field(fields, "requestId"),
        _str_field(fields, "kind"),
        _str_field(fields, "modelId"),
        _str_field(fields, "reason", str(response.get("message", ""))),
        cause=response.get("cause"),
        message=_opt_str(response, "message"),
    )


def _reconstruct_context_overflow(response: dict[str, Any]) -> QvacError:
    fields = _typed_fields(response)
    return ContextOverflowError(
        _opt_num_field(fields, "promptTokens"),
        _opt_num_field(fields, "ctxSize"),
        _opt_str_field(fields, "modelId"),
        cause=response.get("cause"),
        message=_opt_str(response, "message"),
    )


_RECONSTRUCTORS: dict[str, Callable[[dict[str, Any]], QvacError]] = {
    "REQUEST_ID_CONFLICT": _reconstruct_request_id_conflict,
    "REQUEST_NOT_FOUND": _reconstruct_request_not_found,
    "REQUEST_REJECTED_BY_POLICY": _reconstruct_request_rejected,
    "CONTEXT_OVERFLOW": _reconstruct_context_overflow,
}


def _attach_remote_context(err: QvacError, response: dict[str, Any]) -> QvacError:
    stack = _opt_str(response, "stack")
    if stack:
        err.remote_stack = stack
    timestamp = _opt_str(response, "timestamp")
    if timestamp:
        err.timestamp = timestamp
    return err


def reconstruct_error(response: dict[str, Any]) -> QvacError:
    """Rebuild the original server-thrown typed error from its envelope so
    `isinstance(err, RequestRejectedByPolicyError)` works across RPC. Unknown
    names fall through to `RPCError`, which preserves name/code/message."""
    name = response.get("name")
    reconstructor = _RECONSTRUCTORS.get(name) if isinstance(name, str) else None
    if reconstructor is None:
        return RPCError(response)
    try:
        return _attach_remote_context(reconstructor(response), response)
    except Exception:
        # A reconstructor should coerce missing fields to defaults, so this
        # is the edge case (e.g. a future class with a new required field
        # against an older worker). Surface the original error via RPCError
        # rather than let a reconstruction bug mask it.
        return RPCError(response)


__all__ = [
    "QvacError",
    "RPCError",
    "RequestIdConflictError",
    "RequestNotFoundError",
    "RequestRejectedByPolicyError",
    "ContextOverflowError",
    "CancelFailedError",
    "ModelUnloadFailedError",
    "ModelRegistryQueryFailedError",
    "InvalidDeleteCacheParamsError",
    "DeleteCacheFailedError",
    "reconstruct_error",
]
