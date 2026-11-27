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

`__legacy_keys__` maps a key the SDK still accepts for one release to
the wire alias that replaced it, from contract/legacy-keys.json. A
validated model takes the legacy key's value under the alias, keeps the
replacement's value when it is also sent, by alias or by Python name, and
raises a FutureWarning that names
the replacement, once per legacy key per process. The warning is raised
from inside pydantic's validation, where Python's default filters hide a
DeprecationWarning, so FutureWarning is what reaches the caller.

`__ignored_keys__` lists wire keys a model drops before validation: a
deprecated response alias whose Python name is the same as its
replacement's, such as `global_steps` next to `globalSteps`. The Python
attribute does not change, so only the replacement is kept.

`model_post_init` marks every constant field (a single-value `Literal`
with that value as default, such as `type`, `operation` or `modelType`)
as set, so `exclude_unset` serialization always sends these labels.
"""

from __future__ import annotations

import warnings
from collections.abc import Mapping
from functools import cache
from typing import Any, ClassVar, Literal, get_args, get_origin

from pydantic import BaseModel, ConfigDict
from pydantic_core import CoreSchema, core_schema

warned_legacy_keys: set[tuple[str, str]] = set()


class GeneratedBaseModel(BaseModel):
    model_config = ConfigDict(validate_default=True, populate_by_name=True)
    __forbidden_fields__: ClassVar[frozenset[str]] = frozenset()
    __forbidden_field_guidance__: ClassVar[dict[str, str]] = {}
    __legacy_keys__: ClassVar[dict[str, str]] = {}
    __ignored_keys__: ClassVar[frozenset[str]] = frozenset()

    @classmethod
    def __get_pydantic_core_schema__(cls, source: Any, handler: Any) -> CoreSchema:
        schema = handler(source)
        if cls.__ignored_keys__:
            schema = core_schema.no_info_before_validator_function(
                cls._drop_ignored_keys, schema
            )
        if cls.__forbidden_fields__:
            schema = core_schema.no_info_before_validator_function(
                cls._reject_forbidden_fields, schema
            )
        if cls.__legacy_keys__:
            schema = core_schema.no_info_wrap_validator_function(
                cls._rename_legacy_keys, schema
            )
        return schema

    @classmethod
    def _drop_ignored_keys(cls, value: Any) -> Any:
        if isinstance(value, Mapping) and cls.__ignored_keys__.intersection(value):
            return {
                key: item
                for key, item in value.items()
                if key not in cls.__ignored_keys__
            }
        return value

    @classmethod
    def _reject_forbidden_fields(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            forbidden = cls.__forbidden_fields__.intersection(value)
            if forbidden:
                details = "; ".join(
                    f"{field}: {cls.__forbidden_field_guidance__.get(field, 'This field is no longer supported.')}"
                    for field in sorted(forbidden)
                )
                raise ValueError(details)
        return value

    @classmethod
    def _rename_legacy_keys(cls, value: Any, handler: Any) -> Any:
        if not isinstance(value, Mapping):
            return handler(value)
        renamed = {
            legacy: replacement
            for legacy, replacement in cls.__legacy_keys__.items()
            if legacy in value
        }
        if not renamed:
            return handler(value)
        data = {key: item for key, item in value.items() if key not in renamed}
        names = field_names_by_alias(cls)
        ignored = {
            legacy
            for legacy, replacement in renamed.items()
            if replacement in data or names.get(replacement) in data
        }
        for legacy, replacement in renamed.items():
            if legacy not in ignored:
                data.setdefault(replacement, value[legacy])
        result = handler(data)
        for legacy, replacement in renamed.items():
            if (legacy, replacement) in warned_legacy_keys:
                continue
            warned_legacy_keys.add((legacy, replacement))
            message = (
                f'"{legacy}" is deprecated and will be removed in the next release. '
                f'Use "{replacement}" instead.'
            )
            if legacy in ignored:
                message += (
                    f' Its value was ignored because "{replacement}" is also set.'
                )
            warnings.warn(message, FutureWarning, stacklevel=2)
        return result

    def model_post_init(self, context: Any) -> None:
        self.model_fields_set.update(constant_fields(type(self)))


@cache
def field_names_by_alias(cls: type[BaseModel]) -> dict[str, str]:
    return {
        field.alias: name
        for name, field in cls.model_fields.items()
        if field.alias is not None
    }


@cache
def constant_fields(cls: type[BaseModel]) -> frozenset[str]:
    return frozenset(
        name
        for name, field in cls.model_fields.items()
        if get_origin(field.annotation) is Literal
        and len(get_args(field.annotation)) == 1
        and not field.is_required()
    )
