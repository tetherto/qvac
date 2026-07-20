"""Public re-export of the generated model registry catalog — mirrors JS's
`import { QWEN3_600M_INST_Q4 } from '@qvac/sdk'`:

    from qvac.models import QWEN3_600M_INST_Q4
    ...modelSrc=QWEN3_600M_INST_Q4.src...
"""

from __future__ import annotations

# Re-exports both the names and _generated.models_registry's own
# __all__, so `from qvac.models import *` downstream still respects it --
# the __all__ import looks unused to a linter but is what makes that work.
from ._generated.models_registry import *  # noqa: F403
from ._generated.models_registry import __all__  # noqa: F401
