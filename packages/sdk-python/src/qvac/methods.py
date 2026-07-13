"""Public re-export of the generated typed RPC method stubs:

    from qvac.methods import heartbeat, load_model_with_progress
    ...
    response = await heartbeat(transport, HeartbeatRequest(type="heartbeat"))
"""

from __future__ import annotations

from ._generated.methods import *
from ._generated.methods import __all__
