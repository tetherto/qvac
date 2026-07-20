"""QVAC Python SDK client — flat public API.

    from qvac import Client, load_model, completion, embed
    from qvac.models import LLAMA_3_2_1B_INST_Q4_0

    async with Client() as client:
        t = client.transport
        model_id = await load_model(t, model_src=LLAMA_3_2_1B_INST_Q4_0)
        run = completion(t, model_id=model_id, history=[{"role": "user", "content": "hi"}])

Model constants live in `qvac.models`. Every generated request/response model
and enum is re-exported here (and available in full from `qvac.schemas`); the
raw generated method stubs live in `qvac.methods`. The ergonomic wrappers below
shadow the few generated methods that have one (load_model, cancel, translate,
unload_model, delete_cache, model_registry_*, completion_orchestrate).
"""

# ruff: noqa: I001
# Import ORDER is load-bearing here and must not be sorted: the `import *`
# blocks pull in every generated stub, then the ergonomic wrappers below
# deliberately rebind the handful of names that exist as both. Sorting the
# imports would move the wrappers above the star imports and let the raw stubs
# win. (F401/F403 are expected: names are re-exported, __all__ is computed.)
from __future__ import annotations

from .schemas import *  # noqa: F401,F403
from .schemas import __all__ as _schemas_all
from .methods import *  # noqa: F401,F403
from .methods import __all__ as _methods_all
from .errors import *  # noqa: F401,F403
from .errors import __all__ as _errors_all
from .client import Client, WorkerNotFoundError  # noqa: F401
from .logging_streams import (  # noqa: F401
    SDK_ALL_LOG_ID,
    SDK_LOG_ID,
    logging_stream,
    subscribe_server_logs,
)
from .vla import (  # noqa: F401
    vla,
    vla_hparams,
    vla_pad_state,
    vla_preprocess_image,
)

# Ergonomic wrappers — imported last so they win over the generated stubs of
# the same name pulled in by `from .methods import *` above.
from ._api import (  # noqa: F401
    TranslateRun,
    cancel,
    delete_cache,
    generate_client_request_id,
    invoke_plugin,
    invoke_plugin_stream,
    load_model,
    model_registry_get_model,
    model_registry_list,
    model_registry_search,
    translate,
    unload_model,
)
from ._completion import (  # noqa: F401
    CompletionFinal,
    CompletionRun,
    ToolCall,
    completion,
    completion_orchestrate,
    normalize_assistant_cache_content,
)

# The hand-written ergonomic surface; errors, generated methods, and models
# come from the star imports and are folded into __all__ below.
_ERGONOMIC = [
    "Client",
    "WorkerNotFoundError",
    "load_model",
    "unload_model",
    "cancel",
    "delete_cache",
    "translate",
    "TranslateRun",
    "invoke_plugin",
    "invoke_plugin_stream",
    "model_registry_list",
    "model_registry_search",
    "model_registry_get_model",
    "generate_client_request_id",
    "completion",
    "completion_orchestrate",
    "CompletionRun",
    "CompletionFinal",
    "ToolCall",
    "normalize_assistant_cache_content",
    "logging_stream",
    "subscribe_server_logs",
    "SDK_LOG_ID",
    "SDK_ALL_LOG_ID",
    "vla",
    "vla_hparams",
    "vla_preprocess_image",
    "vla_pad_state",
]

__all__ = sorted(
    set(_ERGONOMIC) | set(_errors_all) | set(_methods_all) | set(_schemas_all)
)
