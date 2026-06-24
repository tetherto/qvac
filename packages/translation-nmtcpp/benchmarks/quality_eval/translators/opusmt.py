import os

import torch
from transformers import MarianMTModel, MarianTokenizer
import sys

from tqdm import tqdm
import toolz

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def translate_direct(texts, src_lang, trg_lang, print_config=False):
    """Direct translation from source to target language using OpusMT"""
    # Handle Portuguese-English using roa-en (Romance to English) model
    # and English-Portuguese using direct en-pt model or en-roa with >>por<< prefix
    # Note: pt-en has no direct model, en-pt has opus-mt-tc-big-en-pt
    model_name = f"Helsinki-NLP/opus-mt-{src_lang}-{trg_lang}"
    target_lang_code = None  # For specifying target language in multilingual models

    if src_lang == "pt" and trg_lang == "en":
        model_name = "Helsinki-NLP/opus-mt-roa-en"
        print(f"Using Romance-to-English model for Portuguese: {model_name}", file=sys.stderr)
    elif src_lang == "en" and trg_lang == "pt":
        # Use en-roa with >>por<< prefix (for comparison)
        model_name = "Helsinki-NLP/opus-mt-en-roa"
        target_lang_code = "por"
        # Alternative: use dedicated en-pt model (best quality)
        # model_name = "Helsinki-NLP/opus-mt-tc-big-en-pt"
        print(f"Using English-to-Romance model with >>por<< prefix: {model_name}", file=sys.stderr)

    tokenizer = MarianTokenizer.from_pretrained(model_name)
    model = MarianMTModel.from_pretrained(model_name).to(device)
    results = []

    if print_config:
        # Print generation config for debugging
        cfg = model.generation_config
        print(f"=== Opus-MT Generation Config ({src_lang}->{trg_lang}) ===", file=sys.stderr)
        print(f"num_beams: {getattr(cfg, 'num_beams', 'not set')}", file=sys.stderr)
        print(f"length_penalty: {getattr(cfg, 'length_penalty', 'not set')}", file=sys.stderr)
        print(f"max_length: {getattr(cfg, 'max_length', 'not set')}", file=sys.stderr)
        print(f"repetition_penalty: {getattr(cfg, 'repetition_penalty', 'not set')}", file=sys.stderr)
        print(f"no_repeat_ngram_size: {getattr(cfg, 'no_repeat_ngram_size', 'not set')}", file=sys.stderr)
        print(f"early_stopping: {getattr(cfg, 'early_stopping', 'not set')}", file=sys.stderr)
        print(f"do_sample: {getattr(cfg, 'do_sample', 'not set')}", file=sys.stderr)
        print(f"temperature: {getattr(cfg, 'temperature', 'not set')}", file=sys.stderr)
        print(f"top_k: {getattr(cfg, 'top_k', 'not set')}", file=sys.stderr)
        print(f"top_p: {getattr(cfg, 'top_p', 'not set')}", file=sys.stderr)
        print("=================================", file=sys.stderr)

    # Add target language prefix for multilingual models
    if target_lang_code:
        texts_with_prefix = [f">>{target_lang_code}<< {text}" for text in texts]
    else:
        texts_with_prefix = texts

    for partition in tqdm(list(toolz.partition_all(10, texts_with_prefix)), desc=f"OpusMT {src_lang}->{trg_lang}"):
        tokenized_src = tokenizer(partition, return_tensors="pt", padding=True).to(device)
        generated_tokens = model.generate(**tokenized_src)
        results += tokenizer.batch_decode(generated_tokens, skip_special_tokens=True)

    return results


def translate_pivot(texts, src_lang, trg_lang):
    """Translates texts via English pivot (src -> en -> trg) using OpusMT"""
    print(f"Performing OpusMT pivot translation: {src_lang} -> en -> {trg_lang}", file=sys.stderr)
    
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
    print_config = os.environ.get("PRINT_CONFIG", "false").lower() == "true"
    
    # Check if we should use pivot translation
    if use_pivot and source != "en" and target != "en":
        # Use pivot translation via English
        return translate_pivot(texts, source, target)
    else:
        # Use direct translation
        return translate_direct(texts, source, target, print_config)


if __name__ == "__main__":
    texts = [line.strip() for line in sys.stdin]
    translations = translate(texts)
    sys.stdout.write("\n".join(translations))
    sys.stdout.write("\n")
