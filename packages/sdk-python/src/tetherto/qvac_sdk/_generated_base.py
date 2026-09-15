"""Shared base class for every generated pydantic model (passed to
datamodel-code-generator via --base-class).

`validate_default=True` makes a field's default value go through the
same validation/coercion as an explicit one. Without it, an enum-typed
field whose JSON Schema default is a bare string (e.g. `"default":
"diffusion"` -- the only way JSON Schema can express a default at all)
stays a plain `str` at construction time instead of becoming the enum
member, so `instance.field == SomeEnum.member` silently evaluates to
False for anything relying on that default.

`populate_by_name=True` lets callers construct a request with the
snake_case field name (`EmbedRequest(model_id=...)`) as well as the wire
alias (`modelId`). Wire (de)serialization still uses aliases via
`model_dump(by_alias=True)` / `model_validate`, so this only adds an
ergonomic construction path -- it's what lets a generated request stand
in for a hand-written kwargs wrapper without drifting from the schema.

pydantic merges `model_config` across the class hierarchy, so this
doesn't get lost when a generated subclass sets its own `model_config`
(e.g. `extra="forbid"`).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict
from pydantic_core import CoreSchema, core_schema


class GeneratedBaseModel(BaseModel):
    model_config = ConfigDict(validate_default=True, populate_by_name=True)
    __forbidden_fields__: ClassVar[frozenset[str]] = frozenset()
    __forbidden_field_guidance__: ClassVar[dict[str, str]] = {}

    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: Any) -> CoreSchema:
        schema = handler(source)
        if not cls.__forbidden_fields__:
            return schema

        def reject_forbidden_fields(value: Any) -> Any:
            if isinstance(value, Mapping):
                forbidden = cls.__forbidden_fields__.intersection(value)
                if forbidden:
                    details = "; ".join(
                        f"{field}: {cls.__forbidden_field_guidance__.get(field, 'This field is no longer supported.')}"
                        for field in sorted(forbidden)
                    )
                    raise ValueError(details)
            return value

        return core_schema.no_info_before_validator_function(
            reject_forbidden_fields, schema
        )
