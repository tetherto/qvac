# Pricing
# https://cloud.google.com/translate/pricing

import os
import time
import sys
import requests

from tqdm import tqdm
import toolz

# Get API key from environment variable (REQUIRED)
API_KEY = os.environ.get('GOOGLE_API_KEY')
if not API_KEY:
    print("Error: GOOGLE_API_KEY environment variable is required", file=sys.stderr)
    sys.exit(1)


def translate_direct(texts, src_lang, trg_lang):
    """Translates text directly from source to target language using Google Translate API.

    Languages must be ISO 639-1 language codes.
    See https://g.co/cloud/translate/v2/translate-reference#supported_languages
    """

    def do_translate(partition):
        try:
            url = "https://translation.googleapis.com/language/translate/v2"

            params = {
                'key': API_KEY,
                'source': src_lang,
                'target': trg_lang,
                'format': 'text'
            }

            # Add all texts as 'q' parameters
            for text in partition:
                params.setdefault('q', []).append(text) if isinstance(params.get('q'), list) else None

            # Use list format for multiple texts
            data = {
                'q': list(partition),
                'source': src_lang,
                'target': trg_lang,
                'format': 'text'
            }

            response = requests.post(
                url,
                params={'key': API_KEY},
                json=data,
                headers={'Content-Type': 'application/json'}
            )

            if response.status_code == 200:
                result = response.json()
                if 'data' in result and 'translations' in result['data']:
                    return [t['translatedText'] for t in result['data']['translations']]
            elif response.status_code == 503:
                return None  # Service unavailable, retry
            else:
                print(f"Error: {response.status_code} - {response.text}", file=sys.stderr)
                return None

        except Exception as e:
            print(f"Translation error: {e}", file=sys.stderr)
            return None

    results = []
    # decrease partition size if hitting limit of max 204800 bytes per request
    for partition in tqdm(list(toolz.partition_all(77, texts)), desc=f"Google {src_lang}->{trg_lang}"):
        for attempt in range(7):
            response = do_translate(partition)
            if response is not None:
                results += response
                break

            time.sleep(60)
        else:
            # If all retries failed, add empty translations
            print(f"Failed to translate batch after 7 attempts", file=sys.stderr)
            results += [""] * len(partition)

    return results


def translate_pivot(texts, src_lang, trg_lang):
    """Translates texts via English pivot (src -> en -> trg) using Google Translate"""
    print(f"Performing Google Translate pivot translation: {src_lang} -> en -> {trg_lang}", file=sys.stderr)
    
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
