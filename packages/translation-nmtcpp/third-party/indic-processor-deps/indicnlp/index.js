const { UnicodeIndicTransliterator } = require('./unicode_transliterator')
const { IndicNormalizerFactory } = require('./indic_normalize')
const IndicTokenize = require('./indic_tokenize')
const IndicDetokenize = require('./indic_detokenize')

module.exports = {
  UnicodeIndicTransliterator,
  IndicNormalizerFactory,
  IndicTokenize,
  IndicDetokenize
}
