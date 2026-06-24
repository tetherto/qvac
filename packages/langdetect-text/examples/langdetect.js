'use strict'

const { detectOne, detectMultiple, getLangName, getISO2FromName } = require('..')

function detectMostProbableLanguage (text) {
  const result = detectOne(text)
  console.log(`Text: ${text}\nMost probable language:`, result)
}

function detectMultipleLanguages (text, topK) {
  const results = detectMultiple(text, topK)
  console.log(`Text: ${text}\nTop ${topK} probable languages:`, results)
}

function languageNameLookup () {
  console.log('getLangName("en"):', getLangName('en'))
  console.log('getLangName("fr"):', getLangName('fr'))
  console.log('getLangName("es"):', getLangName('es'))

  console.log('getLangName("eng"):', getLangName('eng'))
  console.log('getLangName("fra"):', getLangName('fra'))
  console.log('getLangName("spa"):', getLangName('spa'))

  console.log('getLangName("invalid"):', getLangName('invalid'))
}

function iso2Lookup () {
  console.log('getISO2FromName("English"):', getISO2FromName('English'))
  console.log('getISO2FromName("French"):', getISO2FromName('French'))
  console.log('getISO2FromName("Spanish"):', getISO2FromName('Spanish'))
  console.log('getISO2FromName("japanese"):', getISO2FromName('japanese'))
  console.log('getISO2FromName("Chinese"):', getISO2FromName('Chinese'))

  console.log('getISO2FromName("Unknown Language"):', getISO2FromName('Unknown Language'))
}

detectMostProbableLanguage('How are you and how was your holiday?')
detectMultipleLanguages('Hola, cómo estás?', 2)
languageNameLookup()
iso2Lookup()
