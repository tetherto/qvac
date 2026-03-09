'use strict'

const { detectOne, detectMultiple, getLangName, getISO2FromName } = require('..')

async function detectMostProbableLanguage (text) {
  const result = await detectOne(text)
  console.log(`Text: ${text}\nMost probable language:`, result)
  console.log('')
}

async function detectMultipleLanguages (text, topK) {
  const results = await detectMultiple(text, topK)
  console.log(`Text: ${text}\nTop ${topK} probable languages:`, results)
  console.log('')
}

function languageNameLookup () {
  console.log('Language name lookups (ISO codes to names):')
  console.log('getLangName("en"):', getLangName('en'))
  console.log('getLangName("fr"):', getLangName('fr'))
  console.log('getLangName("es"):', getLangName('es'))

  console.log('getLangName("eng"):', getLangName('eng'))
  console.log('getLangName("fra"):', getLangName('fra'))
  console.log('getLangName("spa"):', getLangName('spa'))

  console.log('getLangName("invalid"):', getLangName('invalid'))
  console.log('')
}

function iso2Lookup () {
  console.log('ISO2 lookups (language names to ISO codes):')
  console.log('getISO2FromName("English"):', getISO2FromName('English'))
  console.log('getISO2FromName("French"):', getISO2FromName('French'))
  console.log('getISO2FromName("Spanish, Castilian"):', getISO2FromName('Spanish, Castilian'))
  console.log('getISO2FromName("japanese"):', getISO2FromName('japanese'))
  console.log('getISO2FromName("Chinese"):', getISO2FromName('Chinese'))

  console.log('getISO2FromName("Unknown Language"):', getISO2FromName('Unknown Language'))
  console.log('')
}

async function runExamples() {
  console.log('=== CLD2 Language Detection Examples ===\n')
  
  // Detect single language
  await detectMostProbableLanguage('How are you and how was your holiday? I hope you had a great time!')
  await detectMostProbableLanguage('Bonjour, comment allez-vous? J\'espère que vous passez une bonne journée.')
  await detectMostProbableLanguage('Hola, ¿cómo estás? Espero que tengas un buen día.')
  
  // Detect multiple languages
  await detectMultipleLanguages('Hello world, this is a test. We are testing language detection.', 3)
  await detectMultipleLanguages('Bonjour le monde, ceci est un test de détection de langue.', 2)
  
  // Mixed language text
  await detectMultipleLanguages('Hello, bonjour, hola! This text contains mixed languages here.', 3)
  
  // Test with various scripts
  await detectMostProbableLanguage('これは日本語のテキストです。日本語の検出をテストしています。')  // Japanese
  await detectMostProbableLanguage('这是中文文本。我们正在测试中文检测功能。')  // Chinese (Simplified)
  await detectMostProbableLanguage('這是中文文本。我們正在測試中文檢測功能。')  // Chinese (Traditional)
  await detectMostProbableLanguage('Это русский текст. Мы тестируем определение русского языка.')  // Russian
  await detectMostProbableLanguage('هذا نص عربي. نحن نختبر الكشف عن اللغة العربية.')  // Arabic
  await detectMostProbableLanguage('זה טקסט בעברית. אנחנו בודקים זיהוי של השפה העברית.')  // Hebrew
  
  // Language name and ISO lookups (synchronous functions)
  languageNameLookup()
  iso2Lookup()
}

// Run all examples
runExamples().catch(console.error)
