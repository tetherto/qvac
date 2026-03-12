import { getLangName } from "@qvac/langdetect-text";

const AFRICAN_LANGUAGES_KV: [string, string][] = [
    ['afr_Latn', 'Afrikaans'],
    ['swh_Latn', 'Swahili'],
    ['ary_Arab', 'Moroccan Arabic'],
    ['som_Latn', 'Somali'],
    ['amh_Ethi', 'Amharic'],
    ['arz_Arab', 'Egyptian Arabic'],
    ['hau_Latn', 'Hausa'],
    ['kin_Latn', 'Kinyarwanda'],
    ['zul_Latn', 'Zulu'],
    ['ibo_Latn', 'Igbo'],
    ['plt_Latn', 'Plateau Malagasy'],
    ['xho_Latn', 'Xhosa'],
    ['sna_Latn', 'Shona'],
    ['yor_Latn', 'Yoruba'],
    ['nya_Latn', 'Nyanja'],
    ['sot_Latn', 'Southern Sotho'],
    ['tir_Ethi', 'Tigrinya'],
    ['aeb_Arab', 'Tunisian Arabic'],
    ['gaz_Latn', 'Oromo'],
    ['tsn_Latn', 'Tswana'],
]

const AFRICAN_LANGUAGES_MAP = new Map(AFRICAN_LANGUAGES_KV)

export function getLanguage(code: string | undefined): string {
    if (!code) return "";
    if (AFRICAN_LANGUAGES_MAP.has(code)) return AFRICAN_LANGUAGES_MAP.get(code)!;
    const fullName = getLangName(code);
    return fullName ?? code.toUpperCase();
}

export function isAfrican(code: string | undefined) {
    return !!code && AFRICAN_LANGUAGES_MAP.has(code)
}
