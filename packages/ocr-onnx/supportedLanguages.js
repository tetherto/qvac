const latinLangList = ['af', 'az', 'bs', 'cs', 'cy', 'da', 'de', 'en', 'es', 'et',
  'fr', 'ga', 'hr', 'hu', 'id', 'is', 'it', 'ku', 'la', 'lt', 'lv', 'mi', 'ms',
  'mt', 'nl', 'no', 'oc', 'pi', 'pl', 'pt', 'ro', 'rs_latin', 'sk', 'sl', 'sq',
  'sv', 'sw', 'tl', 'tr', 'uz', 'vi']

const arabicLangList = ['ar', 'fa', 'ug', 'ur']
const bengaliLangList = ['bn', 'as', 'mni']
const cyrillicLangList = ['ru', 'rs_cyrillic', 'be', 'bg', 'uk', 'mn', 'abq',
  'ady', 'kbd', 'ava', 'dar', 'inh', 'che', 'lbe', 'lez', 'tab', 'tjk']

const devanagariLangList = ['hi', 'mr', 'ne', 'bh', 'mai', 'ang', 'bho',
  'mah', 'sck', 'new', 'gom', 'sa', 'bgc']

const otherLangList = ['th', 'ch_sim', 'ch_tra', 'ja', 'ko', 'ta', 'te', 'kn']

const otherLangStringMap = {
  th: 'thai',
  ch_tra: 'zh_tra',
  ch_sim: 'zh_sim',
  ja: 'japanese',
  ko: 'korean',
  ta: 'tamil',
  te: 'telugu',
  kn: 'kannada'
}

const onnxOcrAllSupportedLanguages = [
  ...latinLangList,
  ...arabicLangList,
  ...bengaliLangList,
  ...cyrillicLangList,
  ...devanagariLangList,
  ...otherLangList
]

module.exports = {
  latinLangList,
  arabicLangList,
  bengaliLangList,
  cyrillicLangList,
  devanagariLangList,
  otherLangList,
  otherLangStringMap,
  onnxOcrAllSupportedLanguages
}
