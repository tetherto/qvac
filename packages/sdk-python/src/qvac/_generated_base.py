"""Shared base class for every generated pydantic model (passed to
datamodel-code-generator via --base-class).

`validate_default=True` makes a field's default value go through the
same validation/coercion as an explicit one. Without it, an enum-typed
field whose JSON Schema default is a bare string (e.g. `"default":
"diffusion"` -- the only way JSON Schema can express a default at all)
stays a plain `str` at construction time instead of becoming the enum
member, so `instance.field == SomeEnum.member` silently evaluates to
False for anything relying on that default.

pydantic merges `model_config` across the class hierarchy, so this
doesn't get lost when a generated subclass sets its own `model_config`
(e.g. `extra="forbid"`).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class GeneratedBaseModel(BaseModel):
    model_config = ConfigDict(validate_default=True)
