import os

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
import sys
from mtdata import iso

from tqdm import tqdm
import toolz


device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


LANG_CODE_MAP = {
    "ar": "arb_Arab",
    "az": "azj_Latn",
    "fa": "pes_Arab",
    "lv": "lvs_Latn",
    "ms": "zsm_Latn",
    "zh": "zho_Hans",
}


def translate_direct(texts, src_lang, trg_lang):
    """Direct translation from source to target language using NLLB"""
    tokenizer = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M", src_lang=src_lang)
    model = AutoModelForSeq2SeqLM.from_pretrained("facebook/nllb-200-distilled-600M").to(device)
    results = []

    if trg_lang in LANG_CODE_MAP:
        lang_code = LANG_CODE_MAP[trg_lang]
    else:
        lang_code = None
        for lang in tokenizer.additional_special_tokens:
            if lang.startswith(iso.iso3_code(trg_lang)):
                assert (
                    lang_code is None
                ), "Multiple NLLB language codes found for the same language ID, need to disambiguate!"
                lang_code = lang
        assert lang_code is not None, f"Lang code for {trg_lang} was not found"

    forced_bos_token_id = tokenizer.convert_tokens_to_ids(lang_code)

    for partition in tqdm(list(toolz.partition_all(10, texts)), desc=f"NLLB {src_lang}->{trg_lang}"):
        tokenized_src = tokenizer(partition, return_tensors="pt", padding=True).to(device)
        generated_tokens = model.generate(**tokenized_src, forced_bos_token_id=forced_bos_token_id)
        results += tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)

    return results


def translate_pivot(texts, src_lang, trg_lang):
    """Translates texts via English pivot (src -> en -> trg) using NLLB"""
    print(f"Performing NLLB pivot translation: {src_lang} -> en -> {trg_lang}", file=sys.stderr)
    
    # First translate from source to English
    print(f"Step 1: Translating {src_lang} -> en", file=sys.stderr)
    intermediate_texts = translate_direct(texts, src_lang, "en")
    
    # Then translate from English to target
    print(f"Step 2: Translating en -> {trg_lang}", file=sys.stderr)
    final_texts = translate_direct(intermediate_texts, "en", trg_lang)
    
    return final_texts


def translate(texts):
    """Main translation function that decides between direct and pivot translation"""
    source = os.environ["SRC"]
    target = os.environ["TRG"]
    use_pivot = os.environ.get("USE_PIVOT", "false").lower() == "true"
    
    # Check if we should use pivot translation
    if use_pivot and source != "en" and target != "en":
        # Use pivot translation via English
        return translate_pivot(texts, source, target)
    else:
        # Use direct translation
        return translate_direct(texts, source, target)


if __name__ == "__main__":
    texts = [line.strip() for line in sys.stdin]
    translations = translate(texts)
    sys.stdout.write("\n".join(translations))
    sys.stdout.write("\n")
