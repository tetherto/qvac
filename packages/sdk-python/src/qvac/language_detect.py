"""Source-language detection for LLM-backed translate().

Mirrors @qvac/langdetect-text's `detectOne` surface: returns an ISO 639-1
code plus the English language name, with `("und", "Undetermined")` when
nothing can be detected. Backed by lingua (the `langdetect` extra) instead
of JS's tinyld; the detector is built lazily once since construction loads
language models.
"""

from __future__ import annotations

from typing import Any, NamedTuple

try:
    import lingua
except ImportError:  # the langdetect extra is optional
    # lingua ships type hints, so shadowing the module with None needs an
    # explicit opt-out; every use is behind a LANGDETECT_AVAILABLE guard.
    lingua = None  # type: ignore[assignment]

LANGDETECT_AVAILABLE = lingua is not None

_detector: Any = None


class DetectedLanguage(NamedTuple):
    code: str
    language: str


UNDETERMINED = DetectedLanguage("und", "Undetermined")


class LangDetectNotInstalledError(ImportError):
    def __init__(self) -> None:
        super().__init__(
            "lingua is not installed -- install the 'langdetect' extra "
            "(`pip install qvac[langdetect]`) for translate() source-language "
            "auto-detection, or pass `from_` explicitly"
        )


def detect_one(text: str) -> DetectedLanguage:
    """Most probable language of `text`, or UNDETERMINED when detection
    fails. The `language` field is the English name ("French"), which is
    what LLM translation prompts expect -- same as the JS SDK."""
    global _detector
    if lingua is None:
        raise LangDetectNotInstalledError()
    if not isinstance(text, str) or not text.strip():
        return UNDETERMINED
    if _detector is None:
        _detector = lingua.LanguageDetectorBuilder.from_all_languages().build()
    detected = _detector.detect_language_of(text)
    if detected is None:
        return UNDETERMINED
    return DetectedLanguage(detected.iso_code_639_1.name.lower(), detected.name.title())


__all__ = [
    "LANGDETECT_AVAILABLE",
    "DetectedLanguage",
    "UNDETERMINED",
    "LangDetectNotInstalledError",
    "detect_one",
]
