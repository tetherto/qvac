from sacremoses import MosesPunctNormalizer
from sacremoses import MosesTokenizer

from tqdm import tqdm
from joblib import Parallel, delayed

from indicnlp.tokenize import indic_tokenize
from indicnlp.normalize import indic_normalize
from indicnlp.transliterate import unicode_transliterate

import re
from typing import Union

en_tok = MosesTokenizer(lang="en")
en_normalizer = MosesPunctNormalizer()
flores_codes = {
    "asm_Beng": "as",
    "awa_Deva": "hi",
    "ben_Beng": "bn",
    "bho_Deva": "hi",
    "brx_Deva": "hi",
    "doi_Deva": "hi",
    "eng_Latn": "en",
    "gom_Deva": "kK",
    "guj_Gujr": "gu",
    "hin_Deva": "hi",
    "hne_Deva": "hi",
    "kan_Knda": "kn",
    "kas_Arab": "ur",
    "kas_Deva": "hi",
    "kha_Latn": "en",
    "lus_Latn": "en",
    "mag_Deva": "hi",
    "mai_Deva": "hi",
    "mal_Mlym": "ml",
    "mar_Deva": "mr",
    "mni_Beng": "bn",
    "mni_Mtei": "hi",
    "npi_Deva": "ne",
    "ory_Orya": "or",
    "pan_Guru": "pa",
    "san_Deva": "hi",
    "sat_Olck": "or",
    "snd_Arab": "ur",
    "snd_Deva": "hi",
    "tam_Taml": "ta",
    "tel_Telu": "te",
    "urd_Arab": "ur",
}


def preprocess_line(
        line: str,
        normalizer: Union[MosesPunctNormalizer, indic_normalize.IndicNormalizerFactory],
        lang: str,
        transliterate: bool = False,
        remove_tag: bool = True
) -> str:
    """
    Preprocess a line of text by normalizing, tokenization, and possibly transliterating it.

    Args:
        line (str): the line of text to preprocess.
        normalizer (Union[MosesPunctNormalizer, indic_normalize.IndicNormalizerFactory]): an object that performs normalization on the text.
        lang (str): the language of the line of text
        transliterate (bool, optional): whether to transliterate the line of text to devanagari (default: False).
        remove_tag (bool, optional): whether to remove the do not translate tags (`<dnt>` and `</dnt>`) from the line of text (default: True).

    Returns:
        str: preprocessed line of text.
    """
    iso_lang = flores_codes[lang]

    pattern = r'<dnt>(.*?)</dnt>'
    raw_matches = re.findall(pattern, line)

    if iso_lang == "en":
        processed_line = " ".join(en_tok.tokenize(en_normalizer.normalize(line.strip()), escape=False))
    elif transliterate:
        # transliterates from the any specific language to devanagari
        # which is why we specify lang2_code as "hi".
        # line = indic_detokenize.trivial_detokenize(line.strip(), lang)
        processed_line = unicode_transliterate.UnicodeIndicTransliterator.transliterate(
            " ".join(indic_tokenize.trivial_tokenize(normalizer.normalize(line.strip()), iso_lang)),
            iso_lang,
            "hi",
        ).replace(" ् ", "्")
    else:
        # we only need to transliterate for joint training
        processed_line = " ".join(
            indic_tokenize.trivial_tokenize(normalizer.normalize(line.strip()), iso_lang)
        )

    processed_line = processed_line.replace("< dnt >", "<dnt>")
    processed_line = processed_line.replace("< / dnt >", "</dnt>")

    processed_line_matches = re.findall(pattern, processed_line)
    for raw_match, processed_line_match in zip(raw_matches, processed_line_matches):
        processed_line = processed_line.replace(processed_line_match, raw_match)

    if remove_tag:
        processed_line = re.sub("\s+", " ", processed_line.replace("<dnt>", " ")).strip()
        processed_line = re.sub("\s+", " ", processed_line.replace("</dnt>", " ")).strip()

    return processed_line


def preprocess_lines(
        lines: list[str],
        lang: str,
        transliterate: bool = False,
        remove_tag: bool = False
) -> list[str]:
    """
    Preprocess a list of text lines by normalizing, tokenizing and
    script conversion.

    Args:
        lines (list[str]): list of input text lines.
        lang (str): language of the text in the input lines.
        transliterate (bool, optional): whether to transliterate the text to devanagari (default: False).
        remove_tag (bool, optional): whether to remove the do not translate tags (`<dnt>` and `</dnt>`) from the text (default: True).

    Returns:
        list[str]: list of preprocessed text lines
    """
    iso_lang = flores_codes[lang]

    if iso_lang == "en":
        out_lines = Parallel(n_jobs=-1, backend="multiprocessing")(
            delayed(preprocess_line)(line, None, lang, transliterate, remove_tag)
            for line in tqdm(lines, desc="Processing lines")
        )
    else:
        normfactory = indic_normalize.IndicNormalizerFactory()
        normalizer = normfactory.get_normalizer(iso_lang)

        out_lines = Parallel(n_jobs=-1, backend="multiprocessing")(
            delayed(preprocess_line)(line, normalizer, lang, transliterate, remove_tag)
            for line in tqdm(lines, desc="Processing lines")
        )

    return out_lines

