import pytest

from src.parakeet.config import Language
from src.parakeet.dataset.dataset import LANGUAGE_TO_FLEURS_CODE


@pytest.mark.parametrize(
    ("language", "fleurs_code"),
    [
        (Language.HINDI, "hi_in"),
        (Language.GUJARATI, "gu_in"),
        (Language.KANNADA, "kn_in"),
        (Language.TAMIL, "ta_in"),
    ],
)
def test_indic_language_fleurs_codes(language, fleurs_code):
    assert LANGUAGE_TO_FLEURS_CODE[language] == fleurs_code
