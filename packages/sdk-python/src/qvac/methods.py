"""Public re-export of the generated typed RPC method stubs:

from qvac.methods import heartbeat, load_model_with_progress
...
response = await heartbeat(transport, HeartbeatRequest(type="heartbeat"))
"""

from __future__ import annotations

# Re-exports both the names and _generated.methods' own __all__, so
# `from qvac.methods import *` downstream still respects it -- the
# __all__ import looks unused to a linter but is what makes that work.
from ._generated.methods import *  # noqa: F403
from ._generated.methods import __all__  # noqa: F401
