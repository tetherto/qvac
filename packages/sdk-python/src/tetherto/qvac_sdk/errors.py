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

from ._generated.error_codes import (
    CLIENT_ERROR_CODES,
    REGISTRY_ERROR_CODES,
    SERVER_ERROR_CODES,
)

# Numeric codes come from the generated registries (contract/error-codes.json,
# the SDK's schemas/sdk-errors-*.ts), so they can't drift from the TS side --
# generate.py --check fails if a code moves. Only the codes Python references
# are aliased here; the class `name` strings below are the wire identities the
# reconstructor matches on.
_CODES = {**SERVER_ERROR_CODES, **CLIENT_ERROR_CODES, **REGISTRY_ERROR_CODES}

_CODE_CANCEL_FAILED = _CODES["CANCEL_FAILED"]
_CODE_MODEL_LOAD_FAILED = _CODES["MODEL_LOAD_FAILED"]
_CODE_TRANSLATION_FAILED = _CODES["TRANSLATION_FAILED"]
_CODE_TRANSCRIPTION_FAILED = _CODES["TRANSCRIPTION_FAILED"]
_CODE_TEXT_TO_SPEECH_STREAM_FAILED = _CODES["TEXT_TO_SPEECH_STREAM_FAILED"]
_CODE_COMPLETION_FAILED = _CODES["COMPLETION_FAILED"]
_CODE_EMBED_FAILED = _CODES["EMBED_FAILED"]
_CODE_INFERENCE_CANCELLED = _CODES["INFERENCE_CANCELLED"]
_CODE_MODEL_UNLOAD_FAILED = _CODES["MODEL_UNLOAD_FAILED"]
_CODE_REQUEST_ID_CONFLICT = _CODES["REQUEST_ID_CONFLICT"]
_CODE_REQUEST_NOT_FOUND = _CODES["REQUEST_NOT_FOUND"]
_CODE_REQUEST_REJECTED_BY_POLICY = _CODES["REQUEST_REJECTED_BY_POLICY"]
_CODE_CONTEXT_OVERFLOW = _CODES["CONTEXT_OVERFLOW"]
_CODE_DELETE_CACHE_FAILED = _CODES["DELETE_CACHE_FAILED"]
_CODE_INVALID_DELETE_CACHE_PARAMS = _CODES["INVALID_DELETE_CACHE_PARAMS"]
_CODE_MODEL_REGISTRY_QUERY_FAILED = _CODES["QVAC_MODEL_REGISTRY_QUERY_FAILED"]
_CODE_INVALID_RESPONSE_TYPE = _CODES["INVALID_RESPONSE_TYPE"]
_CODE_STREAM_ENDED_WITHOUT_RESPONSE = _CODES["STREAM_ENDED_WITHOUT_RESPONSE"]
_CODE_MODEL_TYPE_REQUIRED = _CODES["MODEL_TYPE_REQUIRED"]
_CODE_MODEL_SRC_TYPE_MISMATCH = _CODES["MODEL_SRC_TYPE_MISMATCH"]


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


class ModelLoadFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "model load failed",
            name="MODEL_LOAD_FAILED",
            code=_CODE_MODEL_LOAD_FAILED,
            cause=cause,
        )


class ModelTypeRequiredError(QvacError):
    def __init__(self, *, cause: Any = None) -> None:
        super().__init__(
            "modelType is required: it could not be inferred from modelSrc",
            name="MODEL_TYPE_REQUIRED",
            code=_CODE_MODEL_TYPE_REQUIRED,
            cause=cause,
        )


class ModelSrcTypeMismatchError(QvacError):
    def __init__(self, inferred: str, resolved: str, *, cause: Any = None) -> None:
        self.inferred = inferred
        self.resolved = resolved
        super().__init__(
            f"modelType {resolved!r} does not match the type inferred "
            f"from modelSrc ({inferred!r})",
            name="MODEL_SRC_TYPE_MISMATCH",
            code=_CODE_MODEL_SRC_TYPE_MISMATCH,
            cause=cause,
        )


class TranslationFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "translation failed",
            name="TRANSLATION_FAILED",
            code=_CODE_TRANSLATION_FAILED,
            cause=cause,
        )


class CompletionFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "completion failed",
            name="COMPLETION_FAILED",
            code=_CODE_COMPLETION_FAILED,
            cause=cause,
        )


class EmbedFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "embed failed",
            name="EMBED_FAILED",
            code=_CODE_EMBED_FAILED,
            cause=cause,
        )


class InferenceCancelledError(QvacError):
    """A long-running inference was cancelled mid-flight. `final`-style
    aggregates reject with this so a cancelled run can't be mistaken for a
    successful one; the partial fields carry whatever the aggregator
    accumulated up to the cancel point (mirrors the JS class)."""

    def __init__(
        self,
        request_id: str,
        *,
        partial_text: str | None = None,
        partial_tool_calls: Any = None,
        partial_stats: Any = None,
        cause: Any = None,
    ) -> None:
        self.request_id = request_id
        self.partial_text = partial_text
        self.partial_tool_calls = partial_tool_calls
        self.partial_stats = partial_stats
        super().__init__(
            f"inference cancelled: {request_id}",
            name="INFERENCE_CANCELLED",
            code=_CODE_INFERENCE_CANCELLED,
            cause=cause,
        )


class TranscriptionFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "transcription failed",
            name="TRANSCRIPTION_FAILED",
            code=_CODE_TRANSCRIPTION_FAILED,
            cause=cause,
        )


class TextToSpeechStreamFailedError(QvacError):
    def __init__(self, message: Any = None, *, cause: Any = None) -> None:
        super().__init__(
            str(message) if message else "text-to-speech stream failed",
            name="TEXT_TO_SPEECH_STREAM_FAILED",
            code=_CODE_TEXT_TO_SPEECH_STREAM_FAILED,
            cause=cause,
        )


class StreamEndedError(QvacError):
    def __init__(self, *, cause: Any = None) -> None:
        super().__init__(
            "stream ended without a terminal response",
            name="STREAM_ENDED_WITHOUT_RESPONSE",
            code=_CODE_STREAM_ENDED_WITHOUT_RESPONSE,
            cause=cause,
        )


class InvalidResponseError(QvacError):
    def __init__(self, expected: str, *, cause: Any = None) -> None:
        self.expected = expected
        super().__init__(
            f"invalid response type: expected {expected!r}",
            name="INVALID_RESPONSE_TYPE",
            code=_CODE_INVALID_RESPONSE_TYPE,
            cause=cause,
        )


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


class InvalidCancelParamsError(QvacError):
    """cancel() was called with neither request_id nor model_id. JS forbids
    this at compile time via its CancelClientInput union; Python guards it at
    runtime, as a QvacError so `except QvacError` catches it like every other
    client-raised error. No wire code -- there is no contract counterpart."""

    def __init__(self, *, cause: Any = None) -> None:
        super().__init__(
            "cancel needs either request_id or model_id",
            name="INVALID_CANCEL_PARAMS",
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


def _reconstruct_translation_failed(response: dict[str, Any]) -> QvacError:
    # Source-language auto-detection now runs in the worker, so the
    # undetermined-language failure crosses the RPC boundary and must
    # reconstruct as the typed class rather than falling through to RPCError.
    return TranslationFailedError(
        _opt_str(response, "message"),
        cause=response.get("cause"),
    )


_RECONSTRUCTORS: dict[str, Callable[[dict[str, Any]], QvacError]] = {
    "REQUEST_ID_CONFLICT": _reconstruct_request_id_conflict,
    "REQUEST_NOT_FOUND": _reconstruct_request_not_found,
    "REQUEST_REJECTED_BY_POLICY": _reconstruct_request_rejected,
    "CONTEXT_OVERFLOW": _reconstruct_context_overflow,
    "TRANSLATION_FAILED": _reconstruct_translation_failed,
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
    "ModelLoadFailedError",
    "ModelTypeRequiredError",
    "ModelSrcTypeMismatchError",
    "TranslationFailedError",
    "TranscriptionFailedError",
    "TextToSpeechStreamFailedError",
    "CompletionFailedError",
    "EmbedFailedError",
    "InferenceCancelledError",
    "StreamEndedError",
    "InvalidResponseError",
    "ModelUnloadFailedError",
    "ModelRegistryQueryFailedError",
    "InvalidDeleteCacheParamsError",
    "InvalidCancelParamsError",
    "DeleteCacheFailedError",
    "reconstruct_error",
]
